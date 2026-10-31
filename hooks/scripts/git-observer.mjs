/**
 * Puts a stand-in for `git` first on the PATH of every Shell command the Cursor agent
 * runs while its conversation is connected to DevSpec, so every commit the agent makes
 * is noted from git itself (item c2a7ab72, after Antigravity's item 9e385793).
 *
 * How it reaches the agent's shell. Cursor's hooks cannot set the environment of the
 * commands it runs, but its preToolUse hook can rewrite a Shell call's input before it
 * runs (`updated_input`, applied by the Shell tool's `applyUpdatedInput`). Cursor's
 * own permission check runs after that, inside the shell executor, on the rewritten
 * command, and it checks each command the shell would run as parsed by tree-sitter-bash.
 * The line below is an `export` declaration, which that parser does not count as a
 * command, so allow-lists, deny rules and prompts decide exactly as for the agent's own
 * text. (Read from cursor-agent 2026.09.18's bundle, and measured by running the
 * parser it ships on prefixed and plain commands: identical commands, redirects and
 * substitutions.) So provenance-assistance.mjs's preToolUse puts one line in front of
 * every Shell command:
 *
 *     export PATH='<folder>':"${PATH#'<folder>':}" DEVSPEC_CURSOR_GIT_GENERATION=… DEVSPEC_CURSOR_GIT_OBSERVATION=…  # DevSpec notes the git commits this command makes
 *
 * The agent's own text follows unchanged and is never parsed for this. Every `git` the
 * command starts, directly, after `cd` or `&&`, with `-C`, in a linked worktree or from
 * a script, finds the stand-in (git-stand-in.mjs) first. Cursor runs each command in
 * bash or zsh and carries the shell's environment over to the next command, so the
 * folder is put first on PATH once (`${PATH#…}` drops a copy already at the front;
 * bash, zsh and dash agree), and the stand-in checks the connection is still live
 * before it acts for a command that did not get the line.
 *
 * What the line carries: the folder and two random ids. No connection id, key or other
 * identity reaches the command; those stay in the private envelope this module writes
 * beside the stand-in, which the stand-in reads.
 *
 * Not covered, and why:
 * - Native Windows. Cursor runs Shell commands there with PowerShell, which cannot take
 *   this line. No prefix is added; the older command-text paths
 *   (provenance-assistance.mjs, commit-observation.mjs) apply as before.
 * - A git found by absolute path (`/usr/bin/git commit`), or a command that resets PATH
 *   (`env -i`), bypasses the stand-in.
 * - Commits git makes for commands other than `commit` (merge, cherry-pick, revert,
 *   rebase, am) are not reported; a rewritten commit is followed by DevSpec through the
 *   `[devspec:<id>]` reference in its message.
 * - Commits made outside the agent's own commands (a person's terminal, an editor) are
 *   never seen, by design.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOwnConnectionState } from './own-connection.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { readRepositorySnapshot } from './repository-context.mjs'
import {
  ENVELOPE_TTL_MS,
  GENERATION_ENV,
  MARKER_WINDOW_BYTES,
  OBSERVATION_ENV,
  STAND_IN_MARKER,
  normalizeRemoteKey,
} from './git-stand-in.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FULL_SHA = /^[0-9a-f]{40}$/
const STAND_IN_SOURCE = fileURLToPath(new URL('./git-stand-in.mjs', import.meta.url))
const STAND_IN_MODULE = 'git-stand-in.mjs'
const PROVIDER_HOSTS = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }

/** The comment that ends the line, and identifies it to every hook that reads commands. */
export const PREFIX_MARKER = '# DevSpec notes the git commits this command makes'

/** Envelopes kept per connection; the oldest go first. Each is one small file. */
const MAX_ENVELOPES = 200
/** The journal is rotated once fully read past this size, so it never grows unbounded. */
const JOURNAL_ROTATE_BYTES = 1024 * 1024
/** Observations remembered as already read, so a re-read never reports twice. */
const MAX_DRAINED_KEYS = 500

export function observerRoot(home = os.homedir()) {
  return path.join(home, '.devspec', 'cursor-git-stand-in')
}

export function connectionsDir(home = os.homedir()) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* best effort */ }
}

/**
 * The connection's folder. Its name is a salted hash of the connection id, not the id
 * itself: the folder's path is on the agent's PATH, and no connection identity reaches
 * the agent's commands. The salt is a private file made once.
 */
export function generationDir(connectionId, home = os.homedir()) {
  const root = observerRoot(home)
  const saltFile = path.join(root, '.salt')
  let salt = null
  try {
    salt = fs.readFileSync(saltFile, 'utf8').trim()
  } catch {
    ensurePrivateDir(root)
    try {
      fs.writeFileSync(saltFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch {
      /* another hook made it first */
    }
    salt = fs.readFileSync(saltFile, 'utf8').trim()
  }
  return path.join(root, createHash('sha256').update(`${salt}:${connectionId}`).digest('hex').slice(0, 32))
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Whether `file` is this plugin's stand-in or any DevSpec plugin's. */
function isStandIn(file, home) {
  try {
    const real = fs.realpathSync(file)
    const rootPath = observerRoot(home)
    const root = fs.existsSync(rootPath) ? fs.realpathSync(rootPath) : rootPath
    if (real.startsWith(`${root}${path.sep}`)) return true
    const head = Buffer.alloc(MARKER_WINDOW_BYTES)
    const fd = fs.openSync(real, 'r')
    try {
      fs.readSync(fd, head, 0, head.length, 0)
    } finally {
      fs.closeSync(fd)
    }
    // This plugin's own, or any DevSpec plugin's: two that each took the other for
    // git looped until the machine ran out of memory.
    return head.toString('latin1').includes(STAND_IN_MARKER)
  } catch {
    return false
  }
}

/** The first `git` on PATH that is not a DevSpec stand-in, as a real path, or null. */
export function findRealGit(env = process.env, home = os.homedir()) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'git')
    if (isExecutable(candidate) && !isStandIn(candidate, home)) {
      try {
        return fs.realpathSync(candidate)
      } catch {
        /* next */
      }
    }
  }
  return null
}

function writeIfChanged(file, text, mode) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return
  } catch {
    /* absent: write it */
  }
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(tmp, text, { mode })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

/** The folder's `git`: a short sh script that starts the stand-in, or git itself. */
export function standInScript({ dir, node, realGit }) {
  const module = path.join(dir, STAND_IN_MODULE)
  return [
    '#!/bin/sh',
    // Every DevSpec stand-in, whichever plugin's, skips a git carrying this line.
    `${STAND_IN_MARKER}: DevSpec for Cursor notes the commits this agent makes, then runs the real git.`,
    "# It is on PATH only for the agent's own shell commands and installs nothing anywhere.",
    `real=${shellQuote(realGit)}`,
    `node=${shellQuote(node)}`,
    `module=${shellQuote(module)}`,
    'if [ -x "$real" ]; then',
    '  if [ -x "$node" ] && [ -f "$module" ]; then exec "$node" "$module" "$real" "$@"; fi',
    '  exec "$real" "$@"',
    'fi',
    '# The real git moved: leave this folder out of PATH and let the shell find git.',
    `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${shellQuote(dir)} | paste -sd: -)`,
    'export PATH',
    'exec git "$@"',
    '',
  ].join('\n')
}

/**
 * Create or refresh the connection's folder: the `git` stand-in, its module (copied,
 * so a plugin update or move mid-conversation never breaks git), and the generation
 * record. Returns `{ dir, id, realGit }` or null when it cannot be set up.
 */
export function ensureGeneration(connectionId, { home = os.homedir(), env = process.env, node = process.execPath } = {}) {
  if (!UUID.test(connectionId ?? '')) return null
  try {
    const dir = generationDir(connectionId, home)
    ensurePrivateDir(dir)
    const recordFile = path.join(dir, 'generation.json')
    let record = readPrivateJson(recordFile)
    const realGit = typeof record?.real_git === 'string' && isExecutable(record.real_git) && !isStandIn(record.real_git, home)
      ? record.real_git
      : findRealGit(env, home)
    if (!realGit) return null
    const connections = connectionsDir(home)
    if (!record || !UUID.test(record.id ?? '') || record.real_git !== realGit || record.node !== node ||
      record.connection_id !== connectionId || record.connections_dir !== connections) {
      record = {
        v: 1,
        id: UUID.test(record?.id ?? '') ? record.id : randomUUID(),
        connection_id: connectionId,
        connections_dir: connections,
        real_git: realGit,
        node,
        updated_at: new Date().toISOString(),
      }
      writePrivateJson(recordFile, record)
    }
    writeIfChanged(path.join(dir, STAND_IN_MODULE), fs.readFileSync(STAND_IN_SOURCE, 'utf8'), 0o600)
    writeIfChanged(path.join(dir, 'git'), standInScript({ dir, node, realGit }), 0o700)
    return { dir, id: record.id, realGit }
  } catch {
    return null
  }
}

/** The line put in front of the agent's command. */
export function standInPrefix({ dir, id }, observationId) {
  const quoted = shellQuote(dir)
  const rest = dir.includes("'") ? '"$PATH"' : `"\${PATH#${quoted}:}"`
  return `export PATH=${quoted}:${rest} ${GENERATION_ENV}=${id} ${OBSERVATION_ENV}=${observationId}  ${PREFIX_MARKER}\n`
}

/** The agent's own command without the stand-in line, and whether it had one. */
export function stripStandInPrefix(command) {
  if (typeof command !== 'string') return { command, observed: false }
  const newline = command.indexOf('\n')
  if (newline < 0) return { command, observed: false }
  const first = command.slice(0, newline)
  if (!first.startsWith('export PATH=') || !first.endsWith(PREFIX_MARKER)) return { command, observed: false }
  return { command: command.slice(newline + 1), observed: true }
}

/**
 * A hook payload with the stand-in line taken back off the command, so every other
 * handler reads (and shows in a room) the command the agent wrote. Cursor gives the
 * rewritten command to postToolUse (`tool_input.command`) and to the shell hooks
 * (`command`). Returns `{ payload, observed }`.
 */
export function withoutStandInPrefix(payload) {
  if (!payload || typeof payload !== 'object') return { payload, observed: false }
  let next = payload
  let observed = false
  for (const key of ['tool_input', 'toolInput']) {
    const raw = next[key]
    const asString = typeof raw === 'string'
    let input = raw
    if (asString) {
      try { input = JSON.parse(raw) } catch { input = null }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue
    for (const field of ['command', 'cmd']) {
      const stripped = stripStandInPrefix(input[field])
      if (!stripped.observed) continue
      const value = { ...input, [field]: stripped.command }
      next = { ...next, [key]: asString ? JSON.stringify(value) : value }
      observed = true
      break
    }
  }
  const top = stripStandInPrefix(next.command)
  if (top.observed) {
    next = { ...next, command: top.command }
    observed = true
  }
  return { payload: next, observed }
}

/**
 * The connected project's repositories as remote identities (`host/owner/repo`), from
 * the repository list DevSpec sent at connect. Empty when the list is missing or
 * DevSpec said it was unavailable: then only a pin brings a repository into scope.
 */
export function projectRepositoryKeys(conversationId, projectId, { home = os.homedir() } = {}) {
  let snapshot = null
  try {
    snapshot = readRepositorySnapshot(conversationId, home)
  } catch {
    return []
  }
  if (!snapshot || snapshot.project_id !== projectId) return []
  const context = snapshot.repository_context
  if (context?.status !== 'available' || !Array.isArray(context.repositories)) return []
  const keys = new Set()
  for (const repo of context.repositories) {
    const fromUrl = normalizeRemoteKey(repo?.git_url ?? '')
    if (fromUrl) keys.add(fromUrl)
    const host = PROVIDER_HOSTS[String(repo?.provider ?? '').toLowerCase()]
    if (host && typeof repo?.full_name === 'string' && repo.full_name.includes('/')) {
      keys.add(`${host}/${repo.full_name.toLowerCase().replace(/\.git$/, '')}`)
    }
  }
  return [...keys]
}

function pruneFiles(dir, now) {
  try {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    if (files.length <= MAX_ENVELOPES / 2) return
    const aged = files
      .map((name) => {
        const file = path.join(dir, name)
        try {
          return { file, at: fs.statSync(file).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
    aged.forEach((entry, index) => {
      if (index >= MAX_ENVELOPES || now - entry.at > ENVELOPE_TTL_MS) fs.rmSync(entry.file, { force: true })
    })
  } catch {
    /* pruning is housekeeping */
  }
}

/** The ids of the claims (`{ id, project_id }`, as provenance-assistance.mjs keeps them) in one project. */
function claimsFor(claims, projectId) {
  const ids = new Set()
  for (const claim of Array.isArray(claims) ? claims : []) {
    const id = typeof claim?.id === 'string' ? claim.id.toLowerCase() : null
    if (id && UUID.test(id) && String(claim.project_id ?? '').toLowerCase() === projectId) ids.add(id)
  }
  return [...ids]
}

/**
 * For one Shell command: the command with the stand-in line in front, or null when
 * the stand-in does not apply (Windows, no live connection bound to this conversation,
 * or the folder could not be set up). Writes the envelope the stand-in reads: the
 * connection and conversation, the project and its repositories, and the tasks
 * claimed in the conversation in that project (`claims`, as `{ id, project_id }`).
 */
export function prepareStandIn({
  command,
  conversationId,
  claims = [],
  projectId = null,
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  now = Date.now(),
  node = process.execPath,
} = {}) {
  try {
    if (platform === 'win32') return null
    if (typeof command !== 'string' || !command.trim() || stripStandInPrefix(command).observed) return null
    if (typeof conversationId !== 'string' || !conversationId) return null
    const state = readOwnConnectionState(conversationId, { home })
    if (!state?.connection_id) return null
    const project = UUID.test(projectId ?? '') ? projectId.toLowerCase()
      : UUID.test(state.project_id ?? '') ? state.project_id.toLowerCase() : null
    const generation = ensureGeneration(state.connection_id, { home, env, node })
    if (!generation) return null
    const observationId = randomUUID()
    const envelopes = path.join(generation.dir, 'envelopes')
    ensurePrivateDir(envelopes)
    writePrivateJson(path.join(envelopes, `${observationId}.json`), {
      v: 1,
      observation: observationId,
      generation: generation.id,
      connection_id: state.connection_id,
      conversation_id: conversationId,
      project_id: project,
      repositories: project ? projectRepositoryKeys(conversationId, project, { home }) : [],
      claims: project ? claimsFor(claims, project) : [],
      created_at: now,
    })
    pruneFiles(envelopes, now)
    return {
      command: `${standInPrefix(generation, observationId)}${command}`,
      observationId,
      connectionId: state.connection_id,
    }
  } catch {
    return null
  }
}

/** Take a short-lived lock file; returns a release function, or null when held. */
export function takeLock(file, { staleMs = 120_000, now = Date.now() } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return () => {
        try { fs.rmSync(file, { force: true }) } catch { /* gone */ }
      }
    } catch {
      try {
        if (now - fs.statSync(file).mtimeMs > staleMs) fs.rmSync(file, { force: true })
        else return null
      } catch {
        return null
      }
    }
  }
  return null
}

function validLine(row) {
  return Boolean(
    row && row.v === 1 && UUID.test(row.generation ?? '') && UUID.test(row.observation ?? '') &&
      typeof row.sha === 'string' && FULL_SHA.test(row.sha) &&
      (row.branch === null || (typeof row.branch === 'string' && row.branch.length <= 255)) &&
      (row.remote === null || (typeof row.remote === 'string' && row.remote.length <= 1024)) &&
      typeof row.worktree === 'string' && path.isAbsolute(row.worktree) &&
      (row.previous_head === null || (typeof row.previous_head === 'string' && FULL_SHA.test(row.previous_head))) &&
      typeof row.amend === 'boolean',
  )
}

/**
 * The connection folders with something waiting: a journal line not read yet, or a
 * report still to send. `{ dir, connectionId }` each.
 */
export function pendingFolders({ home = os.homedir() } = {}) {
  const root = observerRoot(home)
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue
    const dir = path.join(root, name)
    if (!fs.existsSync(path.join(dir, 'pending'))) continue
    const connectionId = readPrivateJson(path.join(dir, 'generation.json'))?.connection_id
    if (UUID.test(connectionId ?? '')) out.push({ dir, connectionId })
  }
  return out
}

/**
 * Read what the stand-in journalled in a connection folder since the last read (the
 * caller holds the folder's lock). Each commit comes back once: only lines of this
 * folder's generation whose envelope this plugin wrote for this connection, not
 * expired, and not read before. Returns a list of `{ sha, branch, remote, worktree,
 * previousHead, amend, observationId, connectionId, projectId, observedAt }`.
 */
export function drainObservations(dir, { now = Date.now() } = {}) {
  const journal = path.join(dir, 'observations.jsonl')
  try {
    if (!fs.existsSync(journal)) return []
    const record = readPrivateJson(path.join(dir, 'generation.json'))
    if (!UUID.test(record?.connection_id ?? '')) return []
    const stateFile = path.join(dir, 'drained.json')
    const state = readPrivateJson(stateFile) ?? {}
    let offset = Number.isInteger(state.offset) && state.offset >= 0 ? state.offset : 0
    const seen = new Set(Array.isArray(state.keys) ? state.keys : [])
    const data = fs.readFileSync(journal)
    if (offset > data.length) offset = 0
    const tail = data.subarray(offset).toString('utf8')
    const end = tail.lastIndexOf('\n')
    if (end < 0) return []
    const observed = []
    for (const line of tail.slice(0, end).split('\n')) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!validLine(row) || row.generation !== record.id) continue
      const key = `${row.observation}:${row.sha}`
      if (seen.has(key)) continue
      const envelope = readPrivateJson(path.join(dir, 'envelopes', `${row.observation}.json`))
      if (
        !envelope || envelope.connection_id !== record.connection_id || envelope.generation !== row.generation ||
        !Number.isFinite(envelope.created_at) || now - envelope.created_at > ENVELOPE_TTL_MS + 60_000
      ) {
        continue
      }
      seen.add(key)
      observed.push({
        sha: row.sha,
        branch: row.branch,
        remote: row.remote,
        worktree: row.worktree,
        previousHead: row.previous_head,
        amend: row.amend,
        observationId: row.observation,
        connectionId: record.connection_id,
        projectId: UUID.test(envelope.project_id ?? '') ? envelope.project_id : null,
        observedAt: typeof row.observed_at === 'string' ? row.observed_at : new Date(now).toISOString(),
      })
    }
    offset += Buffer.byteLength(tail.slice(0, end + 1))
    if (offset === data.length && data.length > JOURNAL_ROTATE_BYTES) {
      fs.renameSync(journal, `${journal}.1`)
      offset = 0
    }
    writePrivateJson(stateFile, { offset, keys: [...seen].slice(-MAX_DRAINED_KEYS) })
    return observed
  } catch {
    return []
  }
}

/** Whether the journal has lines not read yet. */
export function journalUnread(dir) {
  try {
    const size = fs.statSync(path.join(dir, 'observations.jsonl')).size
    const offset = readPrivateJson(path.join(dir, 'drained.json'))?.offset
    return !(Number.isInteger(offset) && offset >= size)
  } catch {
    return false
  }
}

/**
 * Remove folders nobody can use any more: for a connection whose state is gone or
 * ended, untouched for a day, with nothing waiting to be reported. A command that still
 * has such a folder on its PATH simply finds the real git next.
 */
export function pruneStandInFolders({ home = os.homedir(), now = Date.now() } = {}) {
  const root = observerRoot(home)
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue
    const dir = path.join(root, name)
    try {
      if (fs.existsSync(path.join(dir, 'pending'))) continue
      const connectionId = readPrivateJson(path.join(dir, 'generation.json'))?.connection_id
      const state = UUID.test(connectionId ?? '') ? readPrivateJson(path.join(connectionsDir(home), `${connectionId}.json`)) : null
      const idle = now - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000
      if (idle && (!state || state.enabled !== true)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed += 1
      }
    } catch {
      /* next */
    }
  }
  return removed
}
