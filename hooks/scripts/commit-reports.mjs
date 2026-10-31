#!/usr/bin/env node
/**
 * Reports the agent's commits to DevSpec (`report_commit_provenance`) and keeps a log
 * of what happened to each (item c2a7ab72, after Antigravity's item 9e385793).
 *
 * The commits come from the git stand-in's journal (git-stand-in.mjs, set up by
 * git-observer.mjs). The stand-in notes only commits in the connected project's
 * repositories, so nothing here is sent for any other repository. Each report names
 * the repository by its credential-free `origin` URL, or, for a repository with no
 * origin, by the DevSpec pin that brought it into scope. DevSpec's report has no field
 * for an amend, so whether a commit was an amend is kept in the log; a rewritten commit
 * is followed by DevSpec through the `[devspec:<id>]` reference in its message.
 *
 * Nothing here can touch git: reporting runs in hooks after the command is done
 * (postToolUse and stop, and only when the stand-in has left a `pending` file, so an
 * ordinary tool call does not start Node). A report that cannot be sent waits in the
 * connection folder's `queue.json` and is tried again at a later hook, with backoff,
 * until it is sent, refused, or past its attempts or age. Every outcome is a line in
 * `<connection>.commits.log` beside the connection's other files: observed, sent,
 * refused (with DevSpec's reason), skipped, retry or dropped.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CursorMcpRefusal, isRetryableHttpFailure, mcpToolsCall } from './mcp-call.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import {
  connectionsDir,
  drainObservations,
  journalUnread,
  pendingFolders,
  pruneStandInFolders,
  takeLock,
} from './git-observer.mjs'
import { isDirectRun } from './is-direct-run.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * What a report may cost, retried. Each attempt is one small request made from a hook
 * that is running anyway, never a timer or a background process.
 */
export const MAX_ATTEMPTS = 6
export const REPORT_TTL_MS = 24 * 60 * 60 * 1000
const BACKOFF_MS = [0, 15_000, 60_000, 4 * 60_000, 10 * 60_000, 10 * 60_000]
/** One request's wait. The hook has 15 seconds in all. */
const CALL_TIMEOUT_MS = 5_000
/** The commits log is rotated past this size, so it never grows unbounded on disk. */
const LOG_ROTATE_BYTES = 1024 * 1024

export function commitsLogPath(connectionId, home = os.homedir()) {
  return path.join(connectionsDir(home), `${connectionId}.commits.log`)
}

/** Append one line about a commit to the connection's commits log. Never throws. */
export function logCommit(connectionId, entry, { home = os.homedir(), now = Date.now() } = {}) {
  try {
    const file = commitsLogPath(connectionId, home)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`, { mode: 0o600 })
  } catch {
    /* the log is for people; it never stops a report */
  }
}

/**
 * The origin URL as DevSpec may receive it, or null. A URL that carries a password or
 * a token, a query or a fragment, or an scp-style user other than `git`, is never sent.
 */
export function sanitizeRemote(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || /[\s?#\u0000-\u001f\u007f]/.test(value)) return null
  const scp = /^([^/@:]+)@([^/:]+):(.+)$/.exec(value)
  if (scp) return scp[1] === 'git' ? value : null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (!['https:', 'http:', 'ssh:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) return null
      if (url.password || url.search || url.hash) return null
      if (url.username && !(url.protocol.includes('ssh') && url.username === 'git')) return null
      return value
    } catch {
      return null
    }
  }
  // A local path is not a remote DevSpec can match.
  return null
}

/**
 * The report for one observed commit: `{ item }` to queue, or `{ skip: <why> }`.
 * The origin names the repository; a repository without one was brought into scope by
 * a pin naming the project, and the pin is sent instead.
 */
export function reportItem(commit, { now = Date.now() } = {}) {
  let target
  if (commit.remote) {
    const remote = sanitizeRemote(commit.remote)
    if (!remote) return { skip: 'its origin URL carries credentials or is not a network address, so it was not sent' }
    target = { git_remote: remote }
  } else if (UUID.test(commit.projectId ?? '')) {
    target = { pinned_project_id: commit.projectId }
  } else {
    return { skip: 'the repository has no origin remote and no DevSpec project pin' }
  }
  return {
    item: {
      key: `${commit.connectionId}:${commit.sha}`,
      connection_id: commit.connectionId,
      commit_sha: commit.sha,
      branch: commit.branch ?? null,
      observation_id: UUID.test(commit.observationId ?? '') ? commit.observationId : null,
      amend: commit.amend === true,
      worktree: commit.worktree ?? null,
      ...target,
      created_at: now,
      attempts: 0,
      next_attempt_at: now,
    },
  }
}

function repositoryLabel(item) {
  return item.git_remote ?? `pin:${item.pinned_project_id}`
}

function classify(result) {
  if (result?.recorded === true) return { outcome: 'sent' }
  if (result?.recorded === false) {
    return { outcome: 'refused', reason: String(result.message || (result.conflict ? 'another connection already reported this commit' : 'not recorded')) }
  }
  return { outcome: 'retry', reason: 'DevSpec answered without saying whether it was recorded' }
}

function classifyError(error) {
  const message = String(error?.message || error)
  if (error instanceof CursorMcpRefusal || error?.name === 'CursorMcpRefusal') {
    // A failure to store it is DevSpec's own trouble, worth another try; anything else
    // is DevSpec's answer about this commit.
    return /^Could not record commit provenance/i.test(message)
      ? { outcome: 'retry', reason: message.slice(0, 500) }
      : { outcome: 'refused', reason: message.slice(0, 500) }
  }
  if (error?.code === 'timeout' || isRetryableHttpFailure(error) || error?.status === 401 || error?.status === 403 ||
    /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket/i.test(message)) {
    return { outcome: 'retry', reason: message.slice(0, 300) }
  }
  return { outcome: 'refused', reason: message.slice(0, 500) }
}

async function sendOne(item, { home, call }) {
  const state = readPrivateJson(path.join(connectionsDir(home), `${item.connection_id}.json`))
  if (!state?.token || !state?.mcp_url) return { outcome: 'retry', reason: 'the connection\'s DevSpec key is not available' }
  try {
    const result = await call({
      mcpUrl: state.mcp_url,
      token: state.token,
      connectionCapability: state.connection_capability ?? null,
      name: 'report_commit_provenance',
      arguments: {
        connection_id: item.connection_id,
        commit_sha: item.commit_sha,
        ...(item.branch ? { branch: item.branch } : {}),
        ...(item.observation_id ? { observation_id: item.observation_id } : {}),
        ...(item.git_remote ? { git_remote: item.git_remote } : { pinned_project_id: item.pinned_project_id }),
      },
      timeoutMs: CALL_TIMEOUT_MS,
    })
    return classify(result)
  } catch (error) {
    return classifyError(error)
  }
}

function readQueue(dir) {
  const value = readPrivateJson(path.join(dir, 'queue.json'))
  return Array.isArray(value?.reports) ? value.reports.filter((item) => typeof item?.key === 'string' && FULL_SHA.test(item.commit_sha ?? '')) : []
}

/**
 * Report what the stand-in noted in one connection folder: read its journal, queue a
 * report for each new commit, and send what is due until `deadline`. Outcomes are
 * returned for tests and written to the commits log.
 */
async function reportFolder({ dir, connectionId }, { home, call, now, deadline }) {
  const release = takeLock(path.join(dir, 'report.lock'), { now })
  if (!release) return []
  const outcomes = []
  const log = (entry) => logCommit(connectionId, entry, { home, now })
  try {
    const queue = readQueue(dir)
    for (const commit of drainObservations(dir, { now })) {
      const prepared = reportItem(commit, { now })
      if (prepared.skip) {
        log({ outcome: 'skipped', commit_sha: commit.sha, branch: commit.branch, amend: commit.amend, worktree: commit.worktree, reason: prepared.skip })
        outcomes.push({ connectionId, sha: commit.sha, outcome: 'skipped', reason: prepared.skip })
        continue
      }
      if (queue.some((queued) => queued.key === prepared.item.key)) continue
      queue.push(prepared.item)
      log({ outcome: 'observed', commit_sha: commit.sha, branch: commit.branch, amend: commit.amend, repository: repositoryLabel(prepared.item) })
    }

    const kept = []
    for (const item of queue) {
      const base = { commit_sha: item.commit_sha, branch: item.branch ?? null, amend: item.amend === true, repository: repositoryLabel(item) }
      if (now - item.created_at > REPORT_TTL_MS || item.attempts >= MAX_ATTEMPTS) {
        log({ outcome: 'dropped', ...base, attempts: item.attempts, reason: item.last_error ? `gave up: ${item.last_error}` : 'gave up' })
        outcomes.push({ connectionId, sha: item.commit_sha, outcome: 'dropped' })
        continue
      }
      if (item.next_attempt_at > now || Date.now() > deadline) {
        kept.push(item)
        continue
      }
      const attempt = item.attempts + 1
      const result = await sendOne(item, { home, call })
      outcomes.push({ connectionId, sha: item.commit_sha, ...result })
      if (result.outcome === 'retry') {
        log({ outcome: 'retry', ...base, attempts: attempt, reason: result.reason })
        kept.push({ ...item, attempts: attempt, last_error: result.reason, next_attempt_at: now + (BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1)) })
      } else {
        log({ outcome: result.outcome, ...base, attempts: attempt, ...(result.reason ? { reason: result.reason } : {}) })
      }
    }
    if (kept.length > 0) writePrivateJson(path.join(dir, 'queue.json'), { v: 1, reports: kept })
    else fs.rmSync(path.join(dir, 'queue.json'), { force: true })
    // Nothing left to read or send: the hooks need not start Node for this folder. The
    // file goes first, so a line the stand-in appends meanwhile (it writes the file
    // after the line) is never left without one.
    if (kept.length === 0) {
      const pending = path.join(dir, 'pending')
      fs.rmSync(pending, { force: true })
      if (journalUnread(dir)) fs.writeFileSync(pending, '', { mode: 0o600 })
    }
  } catch {
    /* the folder is left as it was for the next hook */
  } finally {
    release()
  }
  return outcomes
}

/**
 * postToolUse and stop: report every connection folder that has something waiting.
 * A folder for a connection that has since ended is still served, so its commits are
 * sent, refused or visibly dropped.
 */
/** How long one hook spends sending: the hook has 15 seconds, and Node needs some of them. */
const SEND_BUDGET_MS = 8_000

export async function reportCommits({ home = os.homedir(), call = mcpToolsCall, now = Date.now(), budgetMs = SEND_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs
  const outcomes = []
  for (const folder of pendingFolders({ home })) {
    outcomes.push(...await reportFolder(folder, { home, call, now, deadline }))
  }
  pruneStandInFolders({ home, now })
  return outcomes
}

if (isDirectRun(import.meta.url)) {
  // Hook output is context for the model: this says nothing there, and always exits 0.
  // The hook input is not needed, but is read so Cursor never writes into a closed pipe.
  if (!process.stdin.isTTY) {
    try { fs.readFileSync(0) } catch { /* nothing to read */ }
  }
  reportCommits().catch(() => {}).finally(() => process.exit(0))
}
