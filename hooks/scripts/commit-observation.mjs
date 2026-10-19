#!/usr/bin/env node
/**
 * Best-effort direct-commit observations, never a Git gate (P4 / 3d1f5f9d).
 * A summary line or a changed HEAD alone does not prove creation. Require a
 * bounded readable direct invocation, its own pre/post pair, one new commit
 * reflog entry, parent continuity, and unchanged repository/connection binding.
 * Merge/rewrite/background/opaque commands remain ingestion/analyzer territory.
 * This is same-user operational evidence, not hostile-process attestation.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { devspecFolderMarker, findProjectPin, gitRemoteOrigin, mainWorkTreeFrom } from './devspec-scope.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const REPORT_TIMEOUT_MS = 2_500
const OBSERVATION_TTL_MS = 10 * 60_000
const MAX_PENDING = 100
const FULL_SHA = /^[0-9a-f]{40}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEREDOC_DELIMITER = /^[A-Za-z_][A-Za-z0-9_]*$/
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function stateDir(env = process.env) {
  if (env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR) return env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR
  if (env.DEVSPEC_CLAUDE_STATE_DIR) return env.DEVSPEC_CLAUDE_STATE_DIR
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return path.join(os.tmpdir(), `devspec-cursor-provenance-${uid}`)
}

function readablePrefix(prefix) {
  const head = prefix[0]?.value
  if (prefix.length === 2 && head === 'cd' && !prefix[1].value.startsWith('-')) return true
  if (prefix.length >= 3 && head === 'git' && prefix[1].value === 'add') return true
  return false
}

export function simpleGitCommit(command, { onInvocation } = {}) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192) return null

  const segments = [[]]
  let word = ''
  let started = false
  let quote = null
  let wordStart = -1

  const endWord = (at) => {
    if (!started) return
    segments[segments.length - 1].push({ value: word, start: wordStart, end: at })
    word = ''
    started = false
    wordStart = -1
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (quote === "'") {
      if (char === "'") { quote = null; continue }
      word += char
      started = true
      continue
    }
    if (quote === '"') {
      if (char === '"') { quote = null; continue }
      if (char === '$' || char === '`' || char === '\\') return null
      word += char
      started = true
      continue
    }

    if (char === '"' || char === "'") {
      if (!started) wordStart = index
      quote = char
      started = true
      continue
    }
    if (char === '&') {
      if (command[index + 1] !== '&') return null
      if (segments.length > 1) return null
      endWord(index)
      segments.push([])
      index += 1
      continue
    }
    if ('|;<>(){}`$\\\n\r'.includes(char)) return null
    if (/\s/.test(char)) {
      endWord(index)
      continue
    }
    if (!started) wordStart = index
    word += char
    started = true
  }
  if (quote) return null
  endWord(command.length)

  if (segments.length === 2 && !readablePrefix(segments[0])) return null
  const words = segments[segments.length - 1]

  if (words.length === 0) return null
  if (words[0].value !== 'git') return null

  const directoryChanges = segments.length === 2 && segments[0][0]?.value === 'cd'
    ? [segments[0][1].value] : []
  let index = 1
  while (index < words.length && words[index].value.startsWith('-')) {
    const option = words[index].value
    if (option === '-C') {
      if (!words[index + 1] || words[index + 1].value.startsWith('-')) return null
      directoryChanges.push(words[index + 1].value)
      index += 2
      continue
    }
    if (option === '--no-pager' || option === '--no-optional-locks') {
      index += 1
      continue
    }
    return null
  }
  if (words[index]?.value !== 'commit') return null

  const rest = words.slice(index + 1)
  const REFUSED = new Set([
    '--amend', '--squash', '--fixup', '--no-edit', '--template', '-t',
    '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
    '--interactive', '-i', '-p', '--patch',
  ])
  for (const entry of rest) {
    if (REFUSED.has(entry.value)) return null
    if (/^(?:--file|--template|--reuse-message|--reedit-message|--squash|--fixup)=/.test(entry.value)) return null
  }

  const messages = []
  for (let i = 0; i < rest.length; i += 1) {
    const entry = rest[i]
    if (entry.value === '-m' || entry.value === '--message') {
      const next = rest[i + 1]
      if (!next) return null
      messages.push(next)
      i += 1
      continue
    }
    if (entry.value.startsWith('--message=')) {
      messages.push({ value: entry.value.slice('--message='.length), start: entry.start, end: entry.end, joined: true })
      continue
    }
    if (/^-m./.test(entry.value)) {
      messages.push({ value: entry.value.slice(2), start: entry.start, end: entry.end, joined: true })
      continue
    }
  }
  if (messages.length !== 1) return null

  const message = messages[0]
  const closing = command[message.end - 1]
  const quoted = closing === '"' || closing === "'"
  onInvocation?.({ directoryChanges, commitArgs: rest.map((entry) => entry.value) })
  return {
    message: message.value,
    insertOffset: message.end - 1,
    appendable: quoted,
  }
}

export function heredocGitCommit(command, options = {}) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192) return null
  if (command.includes('`')) return null

  const open = command.indexOf("<<'")
  if (open === -1) return null
  if (command.indexOf('<<', open + 3) !== -1) return null
  if (command.indexOf('<<', 0) !== open) return null

  const delimEnd = command.indexOf("'", open + 3)
  if (delimEnd === -1) return null
  const delimiter = command.slice(open + 3, delimEnd)
  if (!HEREDOC_DELIMITER.test(delimiter)) return null

  let cursor = delimEnd + 1
  if (command[cursor] === '\r') cursor += 1
  if (command[cursor] !== '\n') return null
  const bodyStart = cursor + 1

  const terminator = `\n${delimiter}`
  let close = command.indexOf(terminator, bodyStart - 1)
  while (close !== -1) {
    const after = command[close + terminator.length]
    if (after === undefined || after === '\n' || after === '\r') break
    close = command.indexOf(terminator, close + 1)
  }
  if (close === -1 || close < bodyStart - 1) return null

  const body = command.slice(bodyStart, close)
  const head = command.slice(0, open)
  const tail = command.slice(close + terminator.length)
  if (head.includes('\n') || head.includes('\r')) return null

  let normalised = null
  const viaStdin = /^(?<pre>.*?)\s(?:-F|--file)\s+-\s*$/.exec(head)
  const viaSubstitution = /^(?<pre>.*?)\s-m\s+"\$\(cat\s*$/.exec(head)
  if (viaStdin) {
    if (!/^\r?\n?$/.test(tail)) return null
    normalised = `${viaStdin.groups.pre} -m "x"`
  } else if (viaSubstitution) {
    if (!/^\r?\n?\)"\r?\n?$/.test(tail)) return null
    normalised = `${viaSubstitution.groups.pre} -m "x"`
  } else {
    return null
  }

  const parsed = simpleGitCommit(normalised, options)
  if (!parsed) return null

  const clean = body.endsWith('\r') ? body.slice(0, -1) : body
  const firstBreak = clean.search(/\r?\n/)
  const subjectEnd = firstBreak === -1 ? bodyStart + clean.length : bodyStart + firstBreak
  return {
    message: clean,
    insertOffset: subjectEnd,
    appendable: clean.length > 0,
  }
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

function sessionFromInput(input, env = process.env) {
  const raw = input?.session_id || input?.conversation_id || input?.conversationId || env?.CURSOR_CONVERSATION_ID
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function commandFromInput(input) {
  const raw = input?.tool_input ?? input?.toolInput
  const obj = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (typeof obj?.command === 'string') return obj.command
  if (typeof obj?.cmd === 'string') return obj.cmd
  if (typeof input?.command === 'string') return input.command
  return null
}

function cwdFromInput(input) {
  if (typeof input?.cwd === 'string' && input.cwd) return input.cwd
  if (typeof input?.working_directory === 'string' && input.working_directory) return input.working_directory
  return null
}

/** Kept for the separate, advisory repository-link nudge; NOT observation proof. */
export function commitRepoDir(command, cwd) {
  if (typeof command !== 'string') return cwd
  const viaC = /\bgit\s+(?:--\S+\s+)*-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command)
  if (viaC) return viaC[2] ?? viaC[3] ?? viaC[4] ?? cwd
  const viaCd = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command)
  return viaCd ? viaCd[2] ?? viaCd[3] ?? viaCd[4] ?? cwd : cwd
}

/** Reuse the message reader rather than building a second shell classifier. */
function directInvocation(command, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  let invocation
  const options = { onInvocation: (value) => { invocation = value } }
  const parsed = simpleGitCommit(command, options) ?? heredocGitCommit(command, options)
  if (!parsed || !invocation) return null
  // The observer's supported direct-creation subset is narrower than the gate.
  // Unknown options, pathspec expansion, dry-run and message-reuse stay unknown.
  const args = invocation.commitArgs
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--message') { i++; continue }
    if (/^(?:-m.|--message=)/.test(args[i])) continue
    if (!['-q', '--quiet', '-a', '--all', '--allow-empty', '--allow-empty-message'].includes(args[i])) return null
  }
  let dir = cwd
  for (const change of invocation.directoryChanges) {
    if (!change || /[\x00\r\n*?\[\]~!]/.test(change)) return null
    dir = path.resolve(dir, change)
  }
  const repoDir = git(['rev-parse', '--show-toplevel'], dir)
  if (!repoDir) return null
  return { repoDir: fs.realpathSync(repoDir), subjectHash: digest(parsed.message.split('\n')[0].trim()) }
}

export function looksCommitProducing(command) {
  return Boolean(simpleGitCommit(command) ?? heredocGitCommit(command))
}

/** Credential-bearing/local/unknown remotes are never persisted or transmitted. */
function safeRemote(raw) {
  if (!raw) return null
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(raw)) return raw
  try {
    const url = new URL(raw)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash) return null
    if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return null
    return url.toString()
  } catch { return null }
}

function repositoryBinding(repoDir) {
  if (!inJurisdiction(repoDir)) return null
  const rawRemote = gitRemoteOrigin(repoDir)
  const remote = safeRemote(rawRemote)
  if (rawRemote && !remote) return null
  const pin = findProjectPin(repoDir)?.project_id
  if (pin && !UUID.test(pin)) return null
  if (!remote && !pin) return null
  return { remote, pin: pin ?? null }
}

/** A hash freezes account, endpoint, project (when supplied) and hidden capability;
 * no credential or command text is copied to an observation marker. */
function connectionBinding(state) {
  if (!state?.connection_id || !state?.mcp_url || !state?.token) return null
  return digest([state.connection_id, state.mcp_url, state.token, state.project_id ?? null,
    state.connection_capability ?? null])
}

export function boundConnection(sessionId, dir = CONNECTIONS_DIR) {
  if (!sessionId) return null
  try {
    const candidates = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name =>
      readPrivateJson(path.join(dir, name))).filter(raw =>
      raw?.enabled === true && raw?.connection_id && raw?.local_id === sessionId)
    // A newer mtime cannot decide which of two live bonds owns this observation.
    return candidates.length === 1 ? candidates[0] : null
  } catch { return null }
}

export function inJurisdiction(dir, env = process.env) {
  try { return Boolean(dir && devspecFolderMarker(dir, {
    home: env.USERPROFILE || env.HOME || os.homedir(), mainWorktree: mainWorkTreeFrom(dir),
  })) }
  catch { return false }
}

function markerPath(sessionId, input, repoDir) {
  const identity = input.tool_use_id || input.toolUseId || digest(commandFromInput(input))
  return path.join(stateDir(), `${digest([sessionId, identity, repoDir])}.observation-v1.json`)
}

function pruneMarkers(now) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const files = fs.readdirSync(stateDir()).filter(name => name.endsWith('.observation-v1.json'))
    .map(name => { const file = path.join(stateDir(), name); return { file, at: fs.statSync(file).mtimeMs } })
    .sort((a, b) => b.at - a.at)
  for (let i = 0; i < files.length; i++) {
    if (i >= MAX_PENDING - 1 || now - files[i].at > OBSERVATION_TTL_MS) fs.rmSync(files[i].file, { force: true })
  }
}

function readHead(repoDir) {
  const sha = git(['rev-parse', '--verify', 'HEAD^{commit}'], repoDir)
  return sha && FULL_SHA.test(sha) ? sha : null
}
function reflog(repoDir, count) {
  // %gD with --date=raw gives reflog time. %ct is COMMIT time, not reflog time.
  return git(['reflog', 'show', `-${count}`, '--date=raw', '--format=%H%x09%gD%x09%gs', 'HEAD'], repoDir)
}

export function handleBashPre(input, options = {}) {
  try {
    const sessionId = sessionFromInput(input, options.env)
    if (!sessionId) return null
    const invocation = directInvocation(commandFromInput(input), cwdFromInput(input))
    if (!invocation) return null
    const { repoDir, subjectHash } = invocation
    const file = markerPath(sessionId, input, repoDir)
    fs.rmSync(file, { force: true })
    const binding = connectionBinding((options.boundConnection ?? boundConnection)(sessionId))
    const repository = repositoryBinding(repoDir)
    if (!binding || !repository) return null
    const now = options.now ?? Date.now()
    const sha = readHead(repoDir)
    const priorReflog = reflog(repoDir, 1)
    if (sha && !priorReflog) return null
    const branch = git(['symbolic-ref', '-q', 'HEAD'], repoDir)
    if (!branch) return null // detached HEAD is explicitly unsupported
    pruneMarkers(now)
    writePrivateJson(file, { version: 1, sha, priorReflog, branch, binding, repository,
      subjectHash, at: now, observationId: crypto.randomUUID() })
  } catch { /* observation is never permission */ }
  return null
}

function consumeMarker(file) {
  // Rename claims one marker atomically; duplicate/concurrent posts cannot both read it.
  const consumed = `${file}.consumed-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, consumed)
    return readPrivateJson(consumed)
  } catch { return null }
  finally { try { fs.rmSync(consumed, { force: true }) } catch { /* best effort */ } }
}

function createdSha(repoDir, before, now) {
  const head = readHead(repoDir)
  if (!head || head === before.sha) return null
  if (git(['symbolic-ref', '-q', 'HEAD'], repoDir) !== before.branch) return null
  const entries = (reflog(repoDir, 2) ?? '').split('\n').filter(Boolean)
  const [sha, selector, action] = (entries[0] ?? '').split('\t')
  const epoch = /@\{(\d+) [+-]\d+\}$/.exec(selector ?? '')?.[1]
  const at = Number(epoch) * 1000
  if (sha !== head || !Number.isFinite(at) || at < before.at - 1000 || at > now + 1000) return null
  const parents = git(['rev-list', '--parents', '-n', '1', head], repoDir)?.split(/\s+/).slice(1)
  if (!parents) return null
  if (before.sha) {
    if (parents.length !== 1 || parents[0] !== before.sha || !action?.startsWith('commit: ')) return null
    if (entries[1] !== before.priorReflog) return null
  } else if (parents.length || entries.length !== 1 || !action?.startsWith('commit (initial): ')) return null
  const subject = git(['show', '-s', '--format=%s', head], repoDir) ?? ''
  const unstampedSubject = subject.replace(/\s*\[devspec:[0-9a-f-]{36}\]$/i, '').trim()
  if (digest(subject) !== before.subjectHash && digest(unstampedSubject) !== before.subjectHash) return null
  return head
}

export async function handleBashPost(input, options = {}) {
  try {
    const sessionId = sessionFromInput(input, options.env)
    if (!sessionId) return null
    const invocation = directInvocation(commandFromInput(input), cwdFromInput(input))
    if (!invocation) return null
    const { repoDir } = invocation
    const before = consumeMarker(markerPath(sessionId, input, repoDir))
    const now = options.now ?? Date.now()
    if (!before || before.version !== 1 || !Number.isFinite(before.at) || now < before.at || now - before.at > OBSERVATION_TTL_MS) return null
    const response = input.tool_response ?? input.toolResponse
    if (input.is_error === true || response?.is_error === true || response?.interrupted === true ||
        (typeof input.exit_code === 'number' && input.exit_code !== 0) ||
        (typeof input.exitCode === 'number' && input.exitCode !== 0) ||
        (typeof response?.exit_code === 'number' && response.exit_code !== 0) ||
        (typeof response?.exitCode === 'number' && response.exitCode !== 0)) return null
    const state = (options.boundConnection ?? boundConnection)(sessionId)
    if (connectionBinding(state) !== before.binding) return null
    const repository = repositoryBinding(repoDir)
    if (!repository || digest(repository) !== digest(before.repository)) return null
    const sha = createdSha(repoDir, before, now)
    if (!sha) return null
    await (options.call ?? mcpToolsCall)({
      mcpUrl: state.mcp_url, token: state.token,
      connectionCapability: state.connection_capability ?? null,
      name: 'report_commit_provenance',
      arguments: { connection_id: state.connection_id, commit_sha: sha,
        observation_id: before.observationId, branch: before.branch.replace(/^refs\/heads\//, ''),
        ...(repository.remote ? { git_remote: repository.remote } : { pinned_project_id: repository.pin }) },
      timeoutMs: options.timeoutMs ?? REPORT_TIMEOUT_MS,
    })
  } catch { /* no retry under a later bond; server ingestion remains the backstop */ }
  return null
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
    if (process.argv[2] === 'pre') handleBashPre(input)
    else if (process.argv[2] === 'post') await handleBashPost(input)
  } catch { /* malformed envelopes and every observation failure fail open */ }
}
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main().catch(() => {})
