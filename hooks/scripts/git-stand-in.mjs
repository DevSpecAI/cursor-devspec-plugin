/**
 * The stand-in for `git` on the Cursor agent's shell PATH (item c2a7ab72).
 *
 * `git-observer.mjs` copies this file into the connection's private folder and puts
 * that folder first on PATH for each Shell command the agent runs, through a one-line
 * prefix the preToolUse hook adds to the command. The folder's `git` is a small sh
 * script that starts
 *
 *     node git-stand-in.mjs <real git> <git arguments...>
 *
 * which runs the real git (the one the command's own PATH leads to, skipping every
 * DevSpec stand-in) with the same arguments, working directory, terminal and standard
 * input, and exits with git's own code or signal. Nothing about git changes:
 * no hook is installed, no configuration is written, nothing is added to any
 * repository.
 *
 * Only for a repository that is the connected project's (its origin is one of the
 * project's repositories, or a DevSpec pin names the project) does it do anything
 * more, and only for `git commit` or an alias that may run it:
 * - Before git runs, it reads the message from git's own arguments, whatever the
 *   shell did to produce them (a heredoc, `$(cat …)`, a file), and
 *   - with one task claimed and no reference, adds ` [devspec:<id>]` to the end of
 *     the subject line (`-m` in place; `-F <file>` through a private copy, never the
 *     person's file; `-F -` by reading the message from standard input) and says so;
 *   - with no task claimed, or several, and no reference, stops the commit before git
 *     runs and says how to recover; the repository is left as it was;
 *   - anything else (amend, fixup, squash, a reused message, `--no-edit`, an existing
 *     reference, a message it cannot read) runs exactly as asked.
 * - It asks git to describe what it did (Trace2, to a private file), so it learns from
 *   git itself, never from the command text, whether a commit was made. When one was,
 *   it appends the full commit id, branch, origin, working tree, previous head and
 *   whether it was an amend to `observations.jsonl` beside it, for the plugin's hooks
 *   to report.
 * A repository that is not the project's gets git exactly as it would without the
 * stand-in: no tag, no check, no trace, nothing noted.
 *
 * What the command carries is two random ids (the folder's generation and this
 * command's observation). Everything else, the connection included, is in private
 * files the hook wrote beside this one. Before acting on them, the stand-in checks that
 * the connection is still live and still this conversation's: Cursor keeps a shell's
 * environment from one command to the next, so a command run after the connection
 * ended still finds this folder on PATH, and then git simply runs straight through.
 *
 * Self-contained (Node built-ins only), so it keeps working from its copy whatever
 * happens to the plugin folder. Every step fails open: if anything about noting the
 * commit goes wrong, git has still run exactly as asked.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_SHA = /^[0-9a-f]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The two ids the command prefix sets. Neither is a credential or an identity. */
export const GENERATION_ENV = 'DEVSPEC_CURSOR_GIT_GENERATION'
export const OBSERVATION_ENV = 'DEVSPEC_CURSOR_GIT_OBSERVATION'

/**
 * How long after a command starts its commits are still credited to it. A command
 * left running in the background can commit after its tool call returns; past this,
 * an observation's envelope no longer counts and git simply runs.
 */
export const ENVELOPE_TTL_MS = 2 * 60 * 60 * 1000

/*
 * What every DevSpec git stand-in agrees on, so that two of them on one PATH never take
 * each other for git (the shared agreement of items 30978c06, 65658d3b and 80bceb2c).
 * The Antigravity, Claude Code and Pi plugins each put a `git` stand-in first on their
 * agent's PATH, and each used to recognise only its own when looking for the real git.
 * On 2026-10-30 two of them on one PATH each picked the other and handed every call
 * back and forth, a new Node process per hop, until the machine ran out of memory. The
 * plugins share this as a contract, not a file:
 *
 * 1. Every stand-in's `git` file carries STAND_IN_MARKER in its first bytes.
 * 2. Looking for the real git, skip any candidate that carries it.
 * 3. Everything a stand-in starts runs one level deeper (STAND_IN_DEPTH_ENV). A stand-in
 *    started inside another's work runs git straight through, and one started
 *    MAX_STAND_IN_DEPTH deep starts nothing: that bounds a loop with an older or foreign
 *    stand-in that does not follow rules 1 and 2.
 *
 * They live here, not in a module of their own, because this file is copied alone.
 */
export const STAND_IN_MARKER = '# devspec-git-stand-in'
export const STAND_IN_DEPTH_ENV = 'DEVSPEC_GIT_STAND_IN_DEPTH'
/** How far into its file a stand-in's marker must be; the other plugins read this much. */
export const MARKER_WINDOW_BYTES = 256
/**
 * How deep stand-ins may nest before one refuses. Real nesting is a stand-in, then git,
 * then a git hook that runs git under a stand-in again: two or three levels. Eight bounds
 * a loop to a few short-lived processes that fail in well under a second.
 */
export const MAX_STAND_IN_DEPTH = 8

/** Whether `file` is a DevSpec git stand-in, whichever plugin wrote it. */
export function isMarkedStandIn(file) {
  let fd = null
  try {
    fd = fs.openSync(fs.realpathSync(file), 'r')
    const head = Buffer.alloc(MARKER_WINDOW_BYTES)
    const read = fs.readSync(fd, head, 0, head.length, 0)
    return head.subarray(0, read).toString('latin1').includes(STAND_IN_MARKER)
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * The git this shell would have run without the stand-in: the first `git` on the
 * command's own PATH that is neither this folder's nor any DevSpec stand-in. Null when
 * there is none; the caller then uses the git found when the folder was set up.
 */
export function realGitOnPath(env, here) {
  let own = null
  try { own = fs.realpathSync(here) } catch { own = here }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'git')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (!fs.statSync(candidate).isFile()) continue
      if (path.dirname(fs.realpathSync(candidate)) === own || fs.realpathSync(dir) === own) continue
      if (isMarkedStandIn(candidate)) continue
      return candidate
    } catch {
      /* next */
    }
  }
  return null
}

/** How many stand-ins this process is already nested inside: 0 unless one started it. */
export function standInDepth(env = process.env) {
  const value = String(env[STAND_IN_DEPTH_ENV] ?? '').trim()
  return /^\d{1,6}$/.test(value) ? Number(value) : 0
}

/** What git prints when a stand-in refuses to go deeper. Read by the person and the agent. */
export function loopStoppedText() {
  return 'git: DevSpec stopped this command because two DevSpec plugins were passing it back and forth instead of running git. Nothing was changed. Update the DevSpec plugin for each coding agent you use, then start a new session.'
}

// Trace2 output of one git command, hooks included, is a few kilobytes; a trace past
// this is not read (and that one commit goes unobserved) rather than held in memory.
const MAX_TRACE_BYTES = 4 * 1024 * 1024

/**
 * Git's own commands that are not `commit`. Anything else that is not `commit` may be
 * an alias, which git expands to a child command; only those are looked at. Leaving a
 * builtin off this list costs a few quick `git rev-parse` calls, never a missed commit.
 */
const NOT_COMMIT = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle',
  'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format',
  'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'clean', 'clone', 'column',
  'commit-graph', 'commit-tree', 'config', 'count-objects', 'credential', 'describe',
  'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'fetch-pack',
  'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help',
  'index-pack', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance',
  'merge', 'merge-base', 'merge-file', 'mergetool', 'mktag', 'mktree', 'mv', 'notes',
  'pack-objects', 'prune', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog',
  'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse',
  'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout',
  'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-objects',
  'update-index', 'update-ref', 'var', 'verify-commit', 'verify-pack', 'verify-tag',
  'version', 'whatchanged', 'worktree', 'write-tree',
])

const VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path'])
const VALUE_PREFIXES = ['--config-env=', '--git-dir=', '--work-tree=', '--namespace=', '--super-prefix=', '--exec-path=']
const FLAG_OPTIONS = new Set([
  '--no-pager', '-P', '--paginate', '-p', '--bare', '--no-replace-objects',
  '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice',
])

/** Split git's own options from the subcommand: `{ globals, command }`, or null for `git --version` and the like. */
export function splitGlobalOptions(args) {
  const globals = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (VALUE_OPTIONS.has(arg)) {
      if (typeof args[i + 1] !== 'string') return null
      globals.push(arg, args[i + 1])
      i += 1
    } else if ((arg.startsWith('-C') || arg.startsWith('-c')) && arg.length > 2) {
      globals.push(arg)
    } else if (VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix)) || FLAG_OPTIONS.has(arg)) {
      globals.push(arg)
    } else if (arg.startsWith('-')) {
      return null
    } else {
      return { globals, command: arg }
    }
  }
  return null
}

function quiet(realGit, args, env) {
  const result = spawnSync(realGit, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    windowsHide: true,
  })
  return result.status === 0 ? result.stdout.trim() : null
}

/** The repository the command is about to act on, and its head before it runs. */
function preflight(realGit, globals, env) {
  const top = quiet(realGit, [...globals, 'rev-parse', '--show-toplevel'], env)
  if (!top) return null
  let worktree
  try {
    worktree = fs.realpathSync(top)
  } catch {
    return null
  }
  const head = quiet(realGit, [...globals, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], env)?.toLowerCase() ?? null
  return { worktree, previousHead: head && FULL_SHA.test(head) ? head : null }
}

/**
 * The commit this command made, read from git's Trace2 events: the top-level command
 * is `commit`, or an alias whose expansion runs `commit`. A commit run by a hook, or
 * by any other child process, is not this command's.
 */
export function commitFromTrace(rows) {
  const root = rows.find((row) => row.event === 'start' && typeof row.sid === 'string' && !row.sid.includes('/'))
  if (!root) return null
  const named = rows.find((row) => {
    if (row.event !== 'cmd_name' || row.name !== 'commit' || typeof row.sid !== 'string') return false
    if (row.sid === root.sid) return true
    return (
      row.sid.startsWith(`${root.sid}/`) &&
      !row.sid.slice(root.sid.length + 1).includes('/') &&
      typeof row.hierarchy === 'string' &&
      row.hierarchy.includes('_run_git_alias_') &&
      row.hierarchy.endsWith('/commit')
    )
  })
  if (!named) return null
  const start = rows.find((row) => row.event === 'start' && row.sid === named.sid)
  const argv = Array.isArray(start?.argv) ? start.argv : []
  if (argv.includes('--dry-run')) return null
  const repo = rows.find((row) => row.event === 'def_repo' && row.sid === named.sid && (row.repo === 1 || row.repo == null))
  if (typeof repo?.worktree !== 'string' || !repo.worktree) return null
  return { worktree: repo.worktree, amend: argv.includes('--amend') }
}

function parents(realGit, worktree, sha, env) {
  const line = quiet(realGit, ['-C', worktree, 'rev-list', '--parents', '-n', '1', sha], env)
  return line ? line.split(/\s+/).slice(1).map((p) => p.toLowerCase()) : null
}

/**
 * Confirm from the repository that the command made exactly this commit: it is the
 * new head, its parents fit what was there before (the old head for a commit, the old
 * head's parents for an amend, none for a first commit), and the head's newest reflog
 * entry is that commit, written by `git commit`. Returns `{ sha, branch, remote }`.
 */
export function confirmCommit(realGit, worktree, previousHead, amend, env = process.env) {
  const sha = quiet(realGit, ['-C', worktree, 'rev-parse', '--verify', 'HEAD^{commit}'], env)?.toLowerCase()
  if (!sha || !FULL_SHA.test(sha) || sha === previousHead) return null
  const now = parents(realGit, worktree, sha, env)
  if (!now) return null
  if (previousHead === null) {
    if (amend || now.length !== 0) return null
  } else if (amend) {
    const before = parents(realGit, worktree, previousHead, env)
    if (!before || before.length !== now.length || before.some((p, i) => p !== now[i])) return null
  } else if (now[0] !== previousHead) {
    return null
  }
  const reflog = quiet(realGit, ['-C', worktree, 'reflog', 'show', '-2', '--format=%H%x09%gs', 'HEAD'], env)
  if (!reflog) return null
  const entries = reflog.split('\n').filter(Boolean).map((line) => line.split('\t'))
  const [topSha = '', action = ''] = entries[0] ?? []
  const expected = previousHead === null ? /^commit \(initial\):/ : amend ? /^commit \(amend\):/ : /^commit( \(merge\))?:/
  if (topSha.toLowerCase() !== sha || !expected.test(action)) return null
  if (previousHead !== null && entries[1]?.[0]?.toLowerCase() !== previousHead) return null
  const branch = quiet(realGit, ['-C', worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], env)
  const remote = quiet(realGit, ['-C', worktree, 'remote', 'get-url', 'origin'], env)
  return {
    sha,
    branch: branch || null,
    remote: remote || null,
  }
}

function readTrace(file) {
  try {
    if (fs.statSync(file).size > MAX_TRACE_BYTES) return []
    const rows = []
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row && typeof row === 'object') rows.push(row)
      } catch {
        /* a partial line from a process still writing: not this command's */
      }
    }
    return rows
  } catch {
    return []
  } finally {
    try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * What the hook left for this command (`envelopes/<observation>.json`): the connection
 * and conversation it was written for, the project's id and repositories, and the
 * tasks claimed in the conversation. Null when it is missing, malformed or too old.
 */
export function readEnvelope(here, observation, generation, now = Date.now()) {
  if (!UUID.test(observation ?? '') || !UUID.test(generation ?? '')) return null
  const value = readJson(path.join(here, 'envelopes', `${observation}.json`))
  if (value?.v !== 1 || value.observation !== observation || value.generation !== generation) return null
  if (!UUID.test(value.connection_id ?? '') || typeof value.conversation_id !== 'string' || !value.conversation_id) return null
  if (!Number.isFinite(value.created_at) || now - value.created_at > ENVELOPE_TTL_MS || value.created_at - now > 60_000) return null
  return value
}

/**
 * Whether the envelope's connection is still live and still bound to the conversation
 * it was written for. The folder's generation record names the connection and where
 * its state lives; the state file is the plugin's own.
 */
export function connectionLive(here, envelope) {
  const record = readJson(path.join(here, 'generation.json'))
  if (!record || record.id !== envelope.generation || record.connection_id !== envelope.connection_id) return false
  if (typeof record.connections_dir !== 'string' || !path.isAbsolute(record.connections_dir)) return false
  const state = readJson(path.join(record.connections_dir, `${envelope.connection_id}.json`))
  return Boolean(state && state.enabled === true && state.connection_id === envelope.connection_id &&
    state.local_id === envelope.conversation_id)
}

// ---- Tagging and the commit check --------------------------------------------

/** Any reference, even a malformed one: a message that has one is never touched. */
export const ANY_REFERENCE = /\[devspec:[^\]\s]*\]/i
/** Forms that reuse or rework an existing message: never tagged, never stopped. */
const REUSING_LONG = new Set(['--amend', '--no-edit', '--fixup', '--squash', '--reuse-message', '--reedit-message'])
const VALUE_LONG = new Set([
  '--message', '--file', '--fixup', '--squash', '--reuse-message', '--reedit-message', '--template',
  '--author', '--date', '--cleanup', '--trailer', '--pathspec-from-file',
])
const FLAG_LONG = new Set([
  '--quiet', '--verbose', '--all', '--include', '--only', '--interactive', '--patch', '--allow-empty',
  '--allow-empty-message', '--no-verify', '--verify', '--edit', '--no-edit', '--no-post-rewrite', '--signoff',
  '--no-signoff', '--reset-author', '--short', '--branch', '--porcelain', '--long', '--null', '--dry-run',
  '--status', '--no-status', '--gpg-sign', '--no-gpg-sign', '--untracked-files', '--pathspec-file-nul',
  '--ahead-behind', '--no-ahead-behind', '--no-verbose', '--no-quiet',
])
const SHORT_FLAGS = new Set(['a', 'q', 'v', 's', 'n', 'e', 'i', 'o', 'p', 'z'])

/**
 * Read `git commit`'s own arguments: where the message comes from, and whether this
 * is a form that reuses a message. Null when an argument is not one it knows, which
 * leaves the commit exactly as asked.
 */
export function parseCommitArgs(rest) {
  const out = { reusing: false, dryRun: false, messages: [], files: [] }
  const take = (list, i, prefix, inline) => {
    if (inline !== null) {
      list.push({ index: i, prefix, value: inline })
      return i
    }
    if (i + 1 >= rest.length) return -1
    list.push({ index: i + 1, prefix: '', value: rest[i + 1] })
    return i + 1
  }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--') break
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq < 0 ? arg : arg.slice(0, eq)
      const inline = eq < 0 ? null : arg.slice(eq + 1)
      if (name === '--dry-run') out.dryRun = true
      if (REUSING_LONG.has(name)) out.reusing = true
      if (name === '--message') i = take(out.messages, i, `${name}=`, inline)
      else if (name === '--file') i = take(out.files, i, `${name}=`, inline)
      else if (VALUE_LONG.has(name)) i = inline === null ? i + 1 : i
      else if (!FLAG_LONG.has(name) && !REUSING_LONG.has(name)) return null
      if (i < 0 || i >= rest.length + 1) return null
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j += 1) {
        const c = arg[j]
        if ('mFcCt'.includes(c)) {
          const inline = j + 1 < arg.length ? arg.slice(j + 1) : null
          const prefix = arg.slice(0, j + 1)
          if (c === 'm') i = take(out.messages, i, prefix, inline)
          else if (c === 'F') i = take(out.files, i, prefix, inline)
          else {
            if (c === 'c' || c === 'C') out.reusing = true
            if (inline === null) i += 1
          }
          if (i < 0 || i >= rest.length + 1) return null
          break
        }
        if (c === 'S' || c === 'u') break
        if (!SHORT_FLAGS.has(c)) return null
      }
      continue
    }
    // A pathspec: git takes options after it too.
  }
  return out
}

/** `host/owner/repo`, lower-cased, from any remote URL form; null when it is not one. */
export function normalizeRemoteKey(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  let host
  let pathname
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      host = url.hostname
      pathname = url.pathname
    } catch {
      return null
    }
  } else if (scp && !value.startsWith('/')) {
    host = scp[1]
    pathname = scp[2]
  } else {
    return null
  }
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    /* keep it as written */
  }
  const clean = decoded.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  return host && clean ? `${host.toLowerCase()}/${clean.toLowerCase()}` : null
}

function readPin(dir) {
  const value = readJson(path.join(dir, '.devspec', 'project.json'))?.project_id
  return typeof value === 'string' ? value.toLowerCase() : null
}

/**
 * Whether the repository git is about to act on is one of the connected project's:
 * its origin is one of the project's repositories, or a pin names the project (in the
 * working tree from where git runs up to its top, or in the main working tree of a
 * linked worktree). The repository, not the folder, decides.
 */
export function inProjectScope(realGit, globals, envelope, env = process.env) {
  const top = quiet(realGit, [...globals, 'rev-parse', '--show-toplevel'], env)
  if (!top) return false
  const repositories = Array.isArray(envelope.repositories) ? envelope.repositories : []
  const remote = normalizeRemoteKey(quiet(realGit, [...globals, 'remote', 'get-url', 'origin'], env) ?? '')
  if (remote && repositories.includes(remote)) return true
  const projectId = typeof envelope.project_id === 'string' && UUID.test(envelope.project_id) ? envelope.project_id.toLowerCase() : null
  if (!projectId) return false
  const prefix = quiet(realGit, [...globals, 'rev-parse', '--show-prefix'], env) ?? ''
  let dir = path.join(top, prefix)
  for (;;) {
    if (readPin(dir) === projectId) return true
    if (path.resolve(dir) === path.resolve(top)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const common = quiet(realGit, [...globals, 'rev-parse', '--path-format=absolute', '--git-common-dir'], env)
  let commonReal = null
  try {
    commonReal = common ? fs.realpathSync(common) : null
  } catch {
    commonReal = null
  }
  return Boolean(commonReal && path.basename(commonReal) === '.git' && readPin(path.dirname(commonReal)) === projectId)
}

/** The message with ` [devspec:<id>]` at the end of its subject line, or null when it has none. */
export function tagSubject(message, id) {
  const lines = message.split('\n')
  const at = lines.findIndex((line) => line.trim().length > 0)
  if (at < 0) return null
  lines[at] = `${lines[at].replace(/\s+$/, '')} [devspec:${id}]`
  return lines.join('\n')
}

/** What the agent is told after the stand-in tagged a commit. */
export function taggedText(id) {
  return `DevSpec: added [devspec:${id}] to the end of this commit's subject line, because it is the one task claimed in this conversation.`
}

/*
 * The two recovery texts follow the wording of provenance-assistance.mjs's
 * NO_CLAIM_MESSAGE and MULTIPLE_CLAIMS_MESSAGE (the command-text path), said for a
 * commit the stand-in stopped. They are written out here because this file is copied
 * alone and imports nothing of the plugin's.
 */

/** Why a commit with no reference was stopped when no task is claimed. */
export function unclaimedText() {
  return [
    'DevSpec stopped this commit before git ran, so nothing was changed: it has no [devspec:<uuid>] reference and no task is claimed in this conversation, so it would land unlinked.',
    'Recover without leaving this turn: search_tasks for the task this work belongs to and claim it (claim_work_item);',
    'if none covers it, create_task for the smallest adequate task, with a real description of the change and the reason it is needed (the server refuses a thin one), and claim that.',
    "When to create one is the contract's work_entry_contract. Then retry the same commit: its [devspec:<id>] reference is added for you.",
  ].join(' ')
}

/** Why a commit with no reference was stopped when several tasks are claimed. */
export function severalClaimsText(claims) {
  return [
    `DevSpec stopped this commit before git ran, so nothing was changed: it has no [devspec:<uuid>] reference and ${claims.length} tasks are claimed in this conversation, so DevSpec will not guess which reference belongs in the commit.`,
    `Add a [devspec:<uuid>] reference for each task this commit delivers (claimed: ${claims.map((id) => `[devspec:${id}]`).join(', ')}) and retry.`,
  ].join(' ')
}

function readAllStdin() {
  const chunks = []
  const buffer = Buffer.alloc(64 * 1024)
  for (;;) {
    let read = 0
    try {
      read = fs.readSync(0, buffer, 0, buffer.length, null)
    } catch (error) {
      if (error.code === 'EAGAIN') continue
      if (error.code === 'EOF') break
      throw error
    }
    if (read === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, read)))
  }
  return Buffer.concat(chunks)
}

/** Text from bytes, or null when the bytes are not UTF-8 that survives a round trip. */
function utf8(bytes) {
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

/**
 * Decide what happens to a commit in the project's repositories before git runs:
 * `{ args, stdin, notice, cleanup }` to run (possibly tagged), or `{ stop }` with the
 * text to show instead of running it. Everything it cannot be sure of runs as asked.
 * `stdin` is 'inherit', or the bytes it had to read, which git gets byte for byte.
 */
export function prepareCommit({ args, split, envelope, here, cwd = process.cwd(), readStdin = readAllStdin }) {
  const unchanged = { args, stdin: 'inherit', notice: null, cleanup: null }
  if (split.command !== 'commit') return unchanged
  const offset = split.globals.length + 1
  const parsed = parseCommitArgs(args.slice(offset))
  if (!parsed || parsed.reusing || parsed.dryRun) return unchanged
  if (parsed.messages.length > 0 && parsed.files.length > 0) return unchanged
  if (parsed.files.length > 1 || (parsed.messages.length === 0 && parsed.files.length === 0)) return unchanged

  let message
  let stdinBytes = null
  const fileSource = parsed.files[0] ?? null
  if (fileSource) {
    if (fileSource.value === '-') {
      stdinBytes = readStdin()
      message = utf8(stdinBytes)
    } else {
      // git reads a relative file from where it runs, after any -C.
      let base = cwd
      for (let i = 0; i < split.globals.length; i += 1) {
        if (split.globals[i] === '-C') base = path.resolve(base, split.globals[i + 1])
        else if (split.globals[i].startsWith('-C') && split.globals[i].length > 2) base = path.resolve(base, split.globals[i].slice(2))
      }
      try {
        message = utf8(fs.readFileSync(path.resolve(base, fileSource.value)))
      } catch {
        return unchanged
      }
    }
  } else {
    message = parsed.messages.map((m) => m.value).join('\n\n')
  }
  const asked = stdinBytes ? { ...unchanged, stdin: stdinBytes } : unchanged
  if (message === null || ANY_REFERENCE.test(message)) return asked

  const claims = (Array.isArray(envelope.claims) ? envelope.claims : []).filter((id) => UUID.test(id ?? '')).map((id) => id.toLowerCase())
  if (claims.length === 0) return { stop: unclaimedText() }
  if (claims.length > 1) return { stop: severalClaimsText(claims) }
  const id = claims[0]

  const next = [...args]
  if (fileSource) {
    const tagged = tagSubject(message, id)
    if (tagged === null) return asked
    // A private copy: the person's own file is never edited.
    const copies = path.join(here, 'messages')
    fs.mkdirSync(copies, { recursive: true, mode: 0o700 })
    const copy = path.join(copies, `${randomUUID()}.txt`)
    fs.writeFileSync(copy, tagged, { mode: 0o600 })
    next[offset + fileSource.index] = `${fileSource.prefix}${copy}`
    // Standard input was the message and has been read: git gets none.
    return { args: next, stdin: stdinBytes ? 'ignore' : 'inherit', notice: taggedText(id), cleanup: copy }
  }
  const first = parsed.messages.find((m) => m.value.trim().length > 0)
  if (!first) return asked
  next[offset + first.index] = `${first.prefix}${tagSubject(first.value, id)}`
  return { args: next, stdin: 'inherit', notice: taggedText(id), cleanup: null }
}

function delegate(realGit, args, env, stdin = 'inherit') {
  return new Promise((resolve) => {
    let child
    try {
      const input = Buffer.isBuffer(stdin) ? 'pipe' : stdin
      child = spawn(realGit, args, { stdio: [input, 'inherit', 'inherit'], env, windowsHide: true })
      if (Buffer.isBuffer(stdin)) {
        child.stdin.on('error', () => { /* git may close its input early */ })
        child.stdin.end(stdin)
      }
    } catch (error) {
      resolve({ code: 126, signal: null, error })
      return
    }
    const forwarded = []
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
      const handler = () => {
        try { child.kill(signal) } catch { /* the child may have gone */ }
      }
      try {
        process.on(signal, handler)
        forwarded.push([signal, handler])
      } catch { /* a signal this platform does not have */ }
    }
    const done = (result) => {
      for (const [signal, handler] of forwarded) process.off(signal, handler)
      resolve(result)
    }
    child.once('error', (error) => done({ code: 126, signal: null, error }))
    child.once('exit', (code, signal) => done({ code: code ?? 1, signal, error: null }))
  })
}

/**
 * Run git for one invocation. `argv` is `[realGit, ...gitArgs]`; `here` is this copy's
 * folder; `depth` is how many stand-ins this process is already inside. Returns
 * `{ code, signal, error }` for the caller to exit with.
 */
export async function runShim(argv = process.argv.slice(2), env = process.env, here = path.dirname(fileURLToPath(import.meta.url)), depth = standInDepth(env), { now = Date.now(), readStdin = readAllStdin, write = (text) => process.stderr.write(text) } = {}) {
  const [recordedGit, ...args] = argv
  // The git the command's own PATH leads to, so the stand-in never swaps one git for
  // another; the one found when the folder was set up is the fallback.
  const realGit = realGitOnPath(env, here) ?? recordedGit
  if (!realGit) return { code: 126, signal: null, error: new Error('git: the DevSpec git stand-in was started without a git to run') }
  // Started inside another stand-in's work: go no deeper than the plugins agree.
  if (depth >= MAX_STAND_IN_DEPTH) return { code: 126, signal: null, error: new Error(loopStoppedText()) }
  // ...and git, with everything else this starts, runs one level deeper.
  const passOn = { ...env, [STAND_IN_DEPTH_ENV]: String(depth + 1) }

  // Never run another copy of this stand-in as "the real git": that recursion has no end.
  try {
    if (path.dirname(fs.realpathSync(realGit)) === fs.realpathSync(here)) {
      return { code: 126, signal: null, error: new Error('git: the DevSpec git stand-in was asked to run itself as git') }
    }
  } catch {
    /* an unresolvable path is reported by spawn itself */
  }
  // ...nor another DevSpec plugin's: that is how two of them looped.
  if (isMarkedStandIn(realGit)) {
    return { code: 126, signal: null, error: new Error('git: the DevSpec git stand-in was asked to run another DevSpec plugin\'s stand-in as git') }
  }

  const observation = env[OBSERVATION_ENV]
  const generation = env[GENERATION_ENV]
  const split = splitGlobalOptions(args)
  let envelope = null
  // Inside another stand-in's work (another plugin's, or a git hook under one), the
  // commit is that one's to tag, check and record: git runs straight through. So does
  // anything that cannot commit, and a command already being traced by someone else.
  if (depth === 0 && split && (split.command === 'commit' || !NOT_COMMIT.has(split.command)) && !env.GIT_TRACE2_EVENT && !env.GIT_TRACE2) {
    try {
      envelope = readEnvelope(here, observation, generation, now)
      if (envelope && !connectionLive(here, envelope)) envelope = null
    } catch {
      envelope = null
    }
  }
  let inScope = false
  if (envelope) {
    try {
      inScope = inProjectScope(realGit, split.globals, envelope, passOn)
    } catch {
      inScope = false
    }
  }

  // Tag the commit, or stop it, before git runs. A failure here runs git exactly as
  // asked; standard input that was already read is passed on whole.
  let run = { args, stdin: 'inherit', notice: null, cleanup: null }
  if (inScope && split.command === 'commit') {
    let readBytes = null
    try {
      run = prepareCommit({
        args, split, envelope, here,
        readStdin: () => {
          readBytes = readStdin()
          return readBytes
        },
      })
    } catch {
      run = { args, stdin: readBytes ?? 'inherit', notice: null, cleanup: null }
    }
    if (run.stop) {
      write(`${run.stop}\n`)
      return { code: 1, signal: null, error: null }
    }
  }

  let before = null
  let traceFile = null
  let childEnv = passOn
  if (inScope) {
    try {
      before = preflight(realGit, split.globals, passOn)
      if (before) {
        const traces = path.join(here, 'traces')
        fs.mkdirSync(traces, { recursive: true, mode: 0o700 })
        traceFile = path.join(traces, `${randomUUID()}.trace`)
        // Made first, so git is only ever pointed at a file it can write: where a
        // sandbox keeps writes inside the workspace this fails, and git is not traced
        // rather than warning about a file it cannot open.
        fs.writeFileSync(traceFile, '', { mode: 0o600, flag: 'wx' })
        childEnv = { ...passOn, GIT_TRACE2_EVENT: traceFile }
      }
    } catch {
      before = null
      traceFile = null
      childEnv = passOn
    }
  }

  const result = await delegate(realGit, run.args, childEnv, run.stdin)
  if (run.cleanup) {
    try { fs.rmSync(run.cleanup, { force: true }) } catch { /* a private copy left behind */ }
  }
  if (run.notice && result.code === 0 && !result.signal) write(`${run.notice}\n`)

  if (traceFile) {
    try {
      const rows = readTrace(traceFile)
      const found = result.code === 0 && !result.signal ? commitFromTrace(rows) : null
      const worktree = found ? fs.realpathSync(found.worktree) : null
      const commit = worktree && worktree === before.worktree
        ? confirmCommit(realGit, worktree, before.previousHead, found.amend, passOn)
        : null
      if (commit) {
        const line = JSON.stringify({
          v: 1,
          generation,
          observation,
          sha: commit.sha,
          branch: commit.branch,
          remote: commit.remote,
          worktree,
          previous_head: before.previousHead,
          amend: found.amend,
          observed_at: new Date().toISOString(),
        })
        // One append per line: concurrent stand-ins never interleave a line.
        fs.appendFileSync(path.join(here, 'observations.jsonl'), `${line}\n`, { mode: 0o600 })
        // Tells the reporting hook there is something to read, without starting Node.
        fs.writeFileSync(path.join(here, 'pending'), '', { mode: 0o600 })
      }
    } catch {
      /* noting the commit never affects git */
    }
  }
  return result
}

let entry = false
try {
  entry = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  entry = false
}
if (entry) {
  // Its own checks before git (quiet() is given this environment) run one level deeper too.
  const depth = standInDepth(process.env)
  process.env[STAND_IN_DEPTH_ENV] = String(depth + 1)
  const result = await runShim(process.argv.slice(2), process.env, path.dirname(fileURLToPath(import.meta.url)), depth)
  if (result.error) process.stderr.write(`${result.error.message}\n`)
  if (result.signal) {
    try { process.kill(process.pid, result.signal) } catch { process.exit(1) }
  } else {
    process.exit(result.code)
  }
}
