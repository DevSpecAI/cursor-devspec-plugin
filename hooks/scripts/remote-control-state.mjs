#!/usr/bin/env node
/**
 * Read/write DevSpec remote-control state — **connection-scoped** + **local
 * conversation bonds** (connection-native model, item fd51d80b).
 *
 * A CONNECTION is a first-class local agent presence, independent of any session
 * (server table agent_connections, mig 442). It is the stable unit here: it exists
 * the moment `register_connection` returns, with or without an attached session, and
 * a connection may later attach to a session (optional shared context). So all
 * client state + poller artifacts are keyed by the server `connection_id`, NOT by a
 * session id.
 *
 * Per-connection files (one per live connection):
 *   ~/.devspec/remote-control/connections/<connection_id>.json
 *   ~/.devspec/remote-control/connections/<connection_id>.poll.pid | .poll.log | .inbox.jsonl
 *
 * Per-local-conversation bonds (create / soft-reconnect / already-live):
 *   ~/.devspec/remote-control/local/<agent-slug>/<local_id>.json
 *   (maps this conversation → its connection_id + optional attached session_id)
 *
 * Legacy single file (still written as a "most recent connection" pointer):
 *   ~/.devspec/remote-control.json
 *
 * Product rules (connection-native):
 *   - bare `/devspec.remote` → register a SESSIONLESS connection for THIS
 *     conversation (no create_session), unless it is already live (re-arm) or has a
 *     recoverable local_stop bond (reconnect).
 *   - `--session <uuid>` → attach the connection to that session (explicit only).
 *   - `--new` → create a session then attach the connection.
 *   - Never pick a session/connection just because it shared a cwd/repo.
 *   - Multiple terminals/agents never steal each other's connections.
 *
 * Usage:
 *   node remote-control-state.mjs write --connection-id <uuid> [--session <uuid>]
 *       [--agent "Cursor"] [--cwd <path>] [--codename "Colorful Possum"]
 *       [--title "…"] [--local-id <id>] [--owner-pid <pid>] [--host-token <bearer>] [--no-poller]
 *   node remote-control-state.mjs ensure-poller --connection-id <uuid> [--session <uuid>] [--owner-pid <pid>]
 *   node remote-control-state.mjs disable --connection-id <uuid>
 *   node remote-control-state.mjs disable-local [--agent "Cursor"] [--local-id <id>]
 *   node remote-control-state.mjs reap [--agent "Cursor"] [--except-connection <uuid>]
 *   node remote-control-state.mjs read [--connection-id <uuid>]
 *   node remote-control-state.mjs list
 *   node remote-control-state.mjs mint-codename
 *   node remote-control-state.mjs mint-local-id
 *   node remote-control-state.mjs resolve-local-id [--local-id <id>] [--agent "Cursor"]
 *   node remote-control-state.mjs resolve-local --agent "Cursor" [--local-id <id>]
 *       [--max-age-minutes 30] [--force-new]
 *     → action: already_live | reconnect | register | create_and_attach
 *   node remote-control-state.mjs register --local-id <id> --project-id <uuid>
 *       [--agent "Cursor"] [--cwd <path>] [--codename "…"] [--hostname <host>]
 *       [--git-remote <url>] [--launch-id <uuid>]
 *     → Node-measured register_connection (item 383de0cd)
 *   node remote-control-state.mjs attach --connection-id <uuid> --session <uuid>
 *       [--launch-id <uuid>]
 *     → Node-measured attach_connection
 *   node remote-control-state.mjs fast-connect --local-id <id> [--session <uuid>]
 *       [--cwd <path>] [--launch-id <uuid>] [--project-id <uuid>] [--prompt-file <path>]
 *       [--no-poller]
 *     → Mechanical register → optional attach → write (poller optional; Cursor
 *       launch defers it until after agent --resume)
 *   node remote-control-state.mjs stop-poller --connection-id <uuid>
 *   node remote-control-state.mjs resolve-auth
 */

import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  durationMs,
  emitConnectPhase,
  resolveLaunchId,
} from './connect-phase-timing.mjs'

const DEVSPEC_DIR = path.join(os.homedir(), '.devspec')
const LEGACY_PATH = path.join(DEVSPEC_DIR, 'remote-control.json')
const CONNECTIONS_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'connections')
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const POLLER_SCRIPT = path.join(THIS_DIR, 'devspec-remote-poll.mjs')

function pollerPidPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.poll.pid`)
}

function pollerLogPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.poll.log`)
}
const LOCAL_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'local')

/** Default window for stop → remote again in the same local conversation. */
const DEFAULT_RECONNECT_MAX_AGE_MINUTES = 30

function connectionPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.json`)
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--connection-id' || a === '--connection_id' || a === '--connection') {
      out['connection-id'] = argv[++i]
    } else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--codename' || a === '--session_codename') out.codename = argv[++i]
    else if (a === '--title') out.title = argv[++i]
    else if (a === '--local-id' || a === '--local_id' || a === '--conversation-id') {
      out['local-id'] = argv[++i]
    } else if (a === '--max-age-minutes' || a === '--max_age_minutes') {
      out['max-age-minutes'] = argv[++i]
    } else if (a === '--owner-pid') {
      out['owner-pid'] = argv[++i]
    } else if (a === '--host-token' || a === '--host_token') {
      out['host-token'] = argv[++i]
    } else if (a === '--except-connection' || a === '--except-session') {
      out['except-connection'] = argv[++i]
    } else if (a === '--no-poller' || a === '--skip-poller') {
      out.noPoller = true
    } else if (a === '--force-new' || a === '--new') {
      out.forceNew = true
    } else if (a === '--launch-id' || a === '--launch_id') {
      out['launch-id'] = argv[++i]
    } else if (a === '--project-id' || a === '--project_id') {
      out['project-id'] = argv[++i]
    } else if (a === '--git-remote' || a === '--git_remote') {
      out['git-remote'] = argv[++i]
    } else if (a === '--hostname' || a === '--machine-hostname' || a === '--machine_hostname') {
      out.hostname = argv[++i]
    } else if (a === '--prompt-file' || a === '--prompt_file') {
      out['prompt-file'] = argv[++i]
    } else out._.push(a)
  }
  return out
}

/**
 * Poller PIDs for this connection — connection-scoped, never matches another
 * connection. Two sources, deduped: the pidfile the launcher records (all
 * platforms) and a Linux /proc cmdline scan (catches pollers with a stale pidfile).
 */
function findPollerPidsForConnection(connectionId) {
  if (!connectionId || connectionId.length < 8) return []
  const pids = new Set()

  // Pidfile — the detached-launch path records the poller pid here.
  try {
    const pidFile = pollerPidPath(connectionId)
    if (fs.existsSync(pidFile)) {
      const n = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(n) && n > 0) {
        try {
          process.kill(n, 0)
          pids.add(n)
        } catch {
          /* stale pid file */
        }
      }
    }
  } catch {
    /* ignore */
  }

  // /proc scan (Linux) — require the poller script AND connection id in the cmdline.
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      let cmd
      try {
        cmd = fs.readFileSync(`/proc/${name}/cmdline`).toString().replace(/\0/g, ' ')
      } catch {
        continue
      }
      if (!cmd.includes('devspec-remote-poll')) continue
      if (!cmd.includes(connectionId)) continue
      if (!/\bnode\b/.test(cmd) && !cmd.includes('node ')) continue
      pids.add(Number(name))
    }
  } catch {
    /* non-Linux or no /proc */
  }

  return [...pids]
}

/** Durable Cursor / Claude agent hosts — never short-lived tool shells (item f3a88333). */
export const WIN32_OWNER_HOST_NAMES = new Set(['cursor.exe', 'agent.exe', 'claude.exe', 'cursor-agent.exe'])

/**
 * Durable hosts that may appear as children of `agent --resume` (item f099fc6e).
 * `Cursor.exe` is the IDE — it is a valid *ancestor* for in-session skill connect,
 * but never a valid *descendant* of the CLI spawn (that would pin the poller to
 * the editor instead of the terminal agent).
 */
export const WIN32_CLI_SPAWN_OWNER_NAMES = new Set(['agent.exe', 'claude.exe', 'cursor-agent.exe'])

/** Ibis: 2.5s ended before agent.exe appeared under powershell-ps1 (item 833df74e). */
export const CLI_SPAWN_OWNER_WALK_TIMEOUT_MS = 15_000

/** Short-lived shells that must not be used as `--owner-pid` anchors on Windows. */
export const WIN32_SHELL_NAMES = new Set(['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe'])

/**
 * Plugin / launcher node scripts that look like `node.exe` but die when the tool call
 * ends — never durable owner anchors (item c57dc381). Keep in sync with the PowerShell
 * walk in resolveOwnerPidAutoWindows and the duplicate in devspec-remote-wait.mjs.
 */
export const WIN32_NODE_EPHEMERAL_CMD_RE =
  /remote-control-state|ensure-poller|devspec-remote-poll|devspec-remote-wait|launch-cli-session/i

/** Cursor CLI often runs as node.exe with cursor-agent in CommandLine (not agent.exe). */
export const WIN32_CURSOR_AGENT_NODE_CMD_RE = /(?:^|[\\/])cursor-agent(?:[\\/]|$)/i

/**
 * Cursor CLI helper `index.js worker-server` — a child of `agent --resume` that
 * exits on its own while the resume session stays up. Pinning the poller to it
 * fires `owner_gone` (Copper Sparrow / Azure Bison / Azure Raccoon, item 5c884554).
 */
export const WIN32_CURSOR_AGENT_WORKER_SERVER_RE = /\bworker-server\b/i

export function isWin32OwnerHostName(name) {
  return WIN32_OWNER_HOST_NAMES.has(String(name || '').toLowerCase())
}

export function isWin32ShellName(name) {
  return WIN32_SHELL_NAMES.has(String(name || '').toLowerCase())
}

/**
 * True when CommandLine proves this node.exe is the Cursor CLI agent host
 * (AppData\\Local\\cursor-agent\\…\\index.js), not an ephemeral plugin script.
 */
export function isWin32CursorAgentNodeCommand(commandLine) {
  const cmd = String(commandLine || '')
  if (!cmd) return false
  if (WIN32_NODE_EPHEMERAL_CMD_RE.test(cmd)) return false
  return WIN32_CURSOR_AGENT_NODE_CMD_RE.test(cmd)
}

export function isWin32CursorAgentWorkerServerCommand(commandLine) {
  return WIN32_CURSOR_AGENT_WORKER_SERVER_RE.test(String(commandLine || ''))
}

/**
 * Cursor CLI node.exe that may own the poller: cursor-agent path, not a plugin
 * script, and not the short-lived worker-server helper (item 5c884554).
 */
export function isWin32CursorAgentDurableNodeCommand(commandLine) {
  if (!isWin32CursorAgentNodeCommand(commandLine)) return false
  return !isWin32CursorAgentWorkerServerCommand(commandLine)
}

/** Name (+ optional CommandLine) is a durable Windows owner host. */
export function isWin32DurableOwnerProcess(name, commandLine = '') {
  const n = String(name || '').toLowerCase()
  if (WIN32_OWNER_HOST_NAMES.has(n)) return true
  if (n === 'node.exe') return isWin32CursorAgentDurableNodeCommand(commandLine)
  return false
}

/**
 * Durable owner inside a just-spawned CLI process tree (walk DOWN from spawn PID).
 * Rejects Cursor.exe (IDE), shells, ephemeral plugin scripts, and worker-server.
 */
export function isWin32CliSpawnOwnerProcess(name, commandLine = '') {
  const n = String(name || '').toLowerCase()
  if (WIN32_CLI_SPAWN_OWNER_NAMES.has(n)) return true
  if (n === 'node.exe') return isWin32CursorAgentDurableNodeCommand(commandLine)
  return false
}

function defaultSleepMs(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * BFS descendants of `rootPid` for a CLI-spawn durable owner.
 * Injectable `processInfoOf` / `childrenOf` keep unit tests off Win32_Process.
 * @param {number} rootPid
 * @param {{
 *   processInfoOf?: (pid: number) => { name?: string, commandLine?: string } | null,
 *   childrenOf?: (pid: number) => number[],
 *   maxNodes?: number,
 * }} [opts]
 * @returns {number | null}
 */
export function walkChildTreeForDurableOwner(rootPid, opts = {}) {
  const processInfoOf = opts.processInfoOf
  const childrenOf = opts.childrenOf || (() => [])
  const maxNodes = opts.maxNodes ?? 40
  const queue = [rootPid]
  const seen = new Set()
  while (queue.length && seen.size < maxNodes) {
    const p = queue.shift()
    if (!Number.isInteger(p) || p < 1 || seen.has(p)) continue
    seen.add(p)
    const info = processInfoOf ? processInfoOf(p) : null
    if (info && isWin32CliSpawnOwnerProcess(info.name, info.commandLine)) return p
    const kids = childrenOf(p)
    if (Array.isArray(kids)) {
      for (const k of kids) {
        const child = Number.parseInt(String(k), 10)
        if (Number.isInteger(child) && child > 1) queue.push(child)
      }
    }
  }
  return null
}

/**
 * Windows: one PowerShell invocation BFS-walks descendants of the spawned CLI
 * process until cursor-agent/agent.exe appears (or timeout). Does not walk
 * parents (that finds Cursor.exe the IDE, or nothing).
 */
export function resolveOwnerPidFromChildTreeWin32(startPid, { maxNodes = 40, timeoutMs = CLI_SPAWN_OWNER_WALK_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') return null
  const pid = Number.parseInt(String(startPid), 10)
  if (!Number.isInteger(pid) || pid < 1) return null
  const timeout = Math.max(0, Number(timeoutMs) || 0)
  const script = [
    `$root = ${pid}`,
    `$maxNodes = ${maxNodes}`,
    `$deadline = (Get-Date).AddMilliseconds(${timeout})`,
    `$ephemeralNode = 'remote-control-state|ensure-poller|devspec-remote-poll|devspec-remote-wait|launch-cli-session'`,
    `$workerServer = '(?i)\\bworker-server\\b'`,
    'do {',
    '  $queue = New-Object System.Collections.Generic.Queue[int]',
    '  $queue.Enqueue($root)',
    '  $seen = @{}',
    '  $n = 0',
    '  while ($queue.Count -gt 0 -and $n -lt $maxNodes) {',
    '    $p = $queue.Dequeue()',
    '    if ($seen.ContainsKey($p)) { continue }',
    '    $seen[$p] = $true',
    '    $n++',
    '    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue',
    '    if ($proc) {',
    '      $name = $proc.Name.ToLowerInvariant()',
    '      $cmd = [string]$proc.CommandLine',
    '      if ($name -eq "agent.exe" -or $name -eq "claude.exe" -or $name -eq "cursor-agent.exe") { Write-Output $proc.ProcessId; exit 0 }',
    '      if ($name -eq "node.exe" -and $cmd -and ($cmd -notmatch $ephemeralNode) -and ($cmd -notmatch $workerServer) -and ($cmd -match "(?i)(?:^|[\\\\/])cursor-agent(?:[\\\\/]|$)")) { Write-Output $proc.ProcessId; exit 0 }',
    '    }',
    '    Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" -ErrorAction SilentlyContinue | ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }',
    '  }',
    '  if ((Get-Date) -ge $deadline) { break }',
    '  Start-Sleep -Milliseconds 50',
    '} while ((Get-Date) -lt $deadline)',
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: Math.max(timeout + 4000, 5000),
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    const found = Number.parseInt(out, 10)
    return Number.isInteger(found) && found > 1 ? found : null
  } catch {
    return null
  }
}

/**
 * Resolve a durable owner PID from a process we just spawned (item f099fc6e).
 *
 * Mechanical Connect runs *before* `agent --resume`, so walking *ancestors* of
 * launch-cli-session never sees cursor-agent. After spawn, walk *descendants*
 * of the child PID (often powershell.exe wrapping agent.ps1 on Windows).
 *
 * POSIX: the spawn PID is the agent — return it.
 * Windows: wait briefly for cursor-agent/agent.exe in the child tree; never
 * treat powershell/cmd/launch-cli-session or Cursor.exe (IDE) as the owner.
 *
 * @param {string | number | null | undefined} rootPid
 * @param {{
 *   platform?: NodeJS.Platform,
 *   processInfoOf?: (pid: number) => { name?: string, commandLine?: string } | null,
 *   childrenOf?: (pid: number) => number[],
 *   walkOnce?: (pid: number) => number | null,
 *   sleepMs?: (ms: number) => void,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   maxNodes?: number,
 * }} [opts]
 * @returns {number | null}
 */
export function resolveOwnerPidFromChildTree(rootPid, opts = {}) {
  const pid = Number.parseInt(String(rootPid ?? ''), 10)
  if (!Number.isInteger(pid) || pid <= 1) return null
  const platform = opts.platform ?? process.platform
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : CLI_SPAWN_OWNER_WALK_TIMEOUT_MS
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 50
  const now = opts.now ?? Date.now
  const sleepMs = opts.sleepMs ?? defaultSleepMs
  const injectable = !!(opts.processInfoOf || opts.childrenOf || opts.walkOnce)

  if (injectable) {
    const deadline = now() + Math.max(0, timeoutMs)
    while (true) {
      const found = opts.walkOnce
        ? opts.walkOnce(pid)
        : walkChildTreeForDurableOwner(pid, opts)
      if (found) return found
      if (now() >= deadline) return null
      sleepMs(intervalMs)
    }
  }

  if (platform !== 'win32') return pid
  return resolveOwnerPidFromChildTreeWin32(pid, {
    timeoutMs,
    maxNodes: opts.maxNodes ?? 40,
  })
}

function persistOwnerPidOnConnection(connectionId, ownerPid) {
  try {
    const prev = readJson(connectionPath(connectionId))
    if (!prev) return
    writeJson(connectionPath(connectionId), {
      ...prev,
      owner_pid: ownerPid,
      updated_at: new Date().toISOString(),
    })
  } catch {
    /* poller still receives --owner-pid on argv */
  }
}

/**
 * After `agent --resume` is spawned, find a durable owner in that child tree
 * and start the poller. Does not abort the CLI on failure — the agent is already
 * running; a warning is the caller's job.
 *
 * @param {string} connectionId
 * @param {string | number | null | undefined} spawnPid
 * @param {{
 *   cwd?: string,
 *   sessionId?: string | null,
 *   resolveOwnerPidFromChildTree?: typeof resolveOwnerPidFromChildTree,
 *   ensurePoller?: typeof ensurePollerForConnection,
 *   childTreeOpts?: object,
 * }} [opts]
 */
export function ensurePollerAfterAgentSpawn(connectionId, spawnPid, opts = {}) {
  if (!connectionId || connectionId.length < 8) {
    return { ok: false, error: 'missing connection id', owner_pid: null }
  }
  const resolveTree = opts.resolveOwnerPidFromChildTree || resolveOwnerPidFromChildTree
  const ownerPid = resolveTree(spawnPid, opts.childTreeOpts || {})
  if (!ownerPid) {
    return {
      ok: false,
      error:
        'no durable owner-pid in spawned agent tree (waited for cursor-agent --resume / agent.exe descendant; powershell/cmd/launch-cli-session/Cursor.exe/worker-server are not anchors)',
      owner_pid: null,
    }
  }
  const ensure = opts.ensurePoller || ensurePollerForConnection
  const poller = ensure(connectionId, {
    cwd: opts.cwd,
    sessionId: opts.sessionId || null,
    ownerPid,
  })
  return { ...poller, owner_pid: ownerPid }
}

/**
 * Explicit --owner-pid values that must not be trusted on win32 — fall through to
 * ancestry walk instead (shells: f3a88333; plain/ephemeral node.exe: c57dc381).
 */
export function shouldIgnoreExplicitWin32Owner(name, commandLine = '') {
  if (isWin32ShellName(name)) return true
  const n = String(name || '').toLowerCase()
  if (n === 'node.exe') return !isWin32CursorAgentDurableNodeCommand(commandLine)
  return false
}

/**
 * Look up Win32 process Name + CommandLine by pid. Returns null when gone / query fails.
 * Injectable via resolveOwnerPid opts for unit tests.
 */
export function win32ProcessInfo(pid, { timeoutMs = 2000 } = {}) {
  if (process.platform !== 'win32') return null
  const id = Number.parseInt(String(pid), 10)
  if (!Number.isInteger(id) || id < 1) return null
  // Two lines: Name then CommandLine (CommandLine may be empty).
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${id}" -ErrorAction SilentlyContinue; ` +
    'if ($p) { Write-Output $p.Name; Write-Output ([string]$p.CommandLine) }'
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    })
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
    const lines = out.split('\n')
    const name = (lines[0] || '').trim()
    if (!name) return null
    const commandLine = lines.slice(1).join('\n').replace(/\n$/, '')
    return { name, commandLine }
  } catch {
    return null
  }
}

/**
 * Look up a Win32 process image name by pid. Returns null when the process is gone
 * or the query fails. Injectable via resolveOwnerPid opts for unit tests.
 */
export function win32ProcessName(pid, opts = {}) {
  return win32ProcessInfo(pid, opts)?.name ?? null
}

/**
 * Windows-only owner-pid self-resolution (items 3cddb3b4 / f3a88333 / c57dc381). On win32
 * this process is commonly invoked from Git Bash (MSYS), whose own `$$`/`$PPID` are
 * MSYS-internal numbers that do NOT correspond to any real Win32 process — querying
 * Win32_Process for bash's reported pid returns nothing, so a caller-supplied
 * `--owner-pid "$PPID"` from that shell is never a trustworthy anchor (verified:
 * MSYS bash reports PPID=1, an orphan sentinel, not a resolvable process). node.exe
 * itself, unlike the MSYS shell, IS a genuine Win32 process, so `process.pid` (this
 * script's own pid) is a real, queryable anchor — walk its Win32_Process ancestry
 * until we reach a durable host (`Cursor.exe`, CLI `agent.exe`, `claude.exe`, or
 * `node.exe` whose CommandLine hosts cursor-agent `--resume` — never `worker-server`,
 * which exits independently of the resume session — Cursor CLI often has no agent.exe),
 * however many shell layers sit in between. A single short-lived PowerShell call
 * does the whole walk (fast: one process spawn, no polling).
 */
export function resolveOwnerPidAutoWindows(startPid = process.pid, { maxHops = 12, timeoutMs = 4000 } = {}) {
  if (process.platform !== 'win32') return null
  const pid = Number.parseInt(String(startPid), 10)
  if (!Number.isInteger(pid) || pid < 1) return null
  const hosts = [...WIN32_OWNER_HOST_NAMES].map((n) => `'${n.replace(/'/g, "''")}'`).join(', ')
  const script = [
    // Avoid `$hosts` — it is a PowerShell automatic variable.
    `$ownerHosts = @(${hosts})`,
    `$ephemeralNode = 'remote-control-state|ensure-poller|devspec-remote-poll|devspec-remote-wait|launch-cli-session'`,
    `$workerServer = '(?i)\\bworker-server\\b'`,
    `$p = ${pid}`,
    `for ($i = 0; $i -lt ${maxHops}; $i++) {`,
    '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue',
    '  if (-not $proc) { break }',
    '  $name = $proc.Name.ToLowerInvariant()',
    '  if ($ownerHosts -contains $name) { Write-Output $proc.ProcessId; break }',
    '  if ($name -eq "node.exe") {',
    '    $cmd = [string]$proc.CommandLine',
    '    if ($cmd -and ($cmd -notmatch $ephemeralNode) -and ($cmd -notmatch $workerServer) -and ($cmd -match "(?i)(?:^|[\\\\/])cursor-agent(?:[\\\\/]|$)")) { Write-Output $proc.ProcessId; break }',
    '  }',
    '  if (-not $proc.ParentProcessId -or $proc.ParentProcessId -eq $p) { break }',
    '  $p = $proc.ParentProcessId',
    '}',
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    const found = Number.parseInt(out, 10)
    return Number.isInteger(found) && found > 1 ? found : null
  } catch {
    return null
  }
}

/**
 * Resolve the effective owner-pid for this call.
 *
 * On POSIX, an explicit valid `--owner-pid` wins. On win32, an explicit pid that is
 * clearly a short-lived tool shell (powershell / pwsh / cmd / bash) or a non-
 * cursor-agent `node.exe` is ignored and we walk up to Cursor/agent/cursor-agent
 * instead — those processes exit when the tool call ends and would otherwise fire
 * `owner_gone` mid-session (items f3a88333 / c57dc381). Otherwise attempt Windows
 * self-resolution; otherwise fall back to a previously-recorded value. Returns null
 * if none.
 *
 * `opts.processInfoOf` / `opts.processNameOf` / `opts.processCommandLineOf` /
 * `opts.resolveAuto` are test hooks only.
 */
export function resolveOwnerPid(explicitArg, prevValue, opts = {}) {
  const explicit = Number.parseInt(String(explicitArg ?? ''), 10)
  if (Number.isInteger(explicit) && explicit > 1) {
    if (process.platform === 'win32') {
      let name = null
      let commandLine = ''
      if (opts.processNameOf || opts.processCommandLineOf) {
        name = opts.processNameOf ? opts.processNameOf(explicit) : null
        commandLine = opts.processCommandLineOf ? String(opts.processCommandLineOf(explicit) ?? '') : ''
      } else {
        const infoFn = opts.processInfoOf ?? win32ProcessInfo
        const info = infoFn(explicit)
        name = info?.name ?? null
        commandLine = info?.commandLine ?? ''
      }
      if (name && shouldIgnoreExplicitWin32Owner(name, commandLine)) {
        // Fall through — not a durable owner anchor.
      } else {
        return explicit
      }
    } else {
      return explicit
    }
  }
  const resolveAuto = opts.resolveAuto ?? resolveOwnerPidAutoWindows
  const auto = resolveAuto()
  if (auto) return auto
  const prev = Number.parseInt(String(prevValue ?? ''), 10)
  return Number.isInteger(prev) && prev > 1 ? prev : null
}

function stopPollerForConnection(connectionId) {
  const pids = findPollerPidsForConnection(connectionId)
  const killed = []
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch {
      /* already gone */
    }
  }
  try {
    const pidFile = pollerPidPath(connectionId)
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
  } catch {
    /* ignore */
  }
  return { connection_id: connectionId, pids_found: pids, pids_killed: killed }
}

/**
 * Ensure exactly one continuous heartbeat poller for this connection: stop any prior
 * one (so reconnects never multiply orphans), then spawn a fresh detached poller.
 * Pass ownerPid so the spawned poller anchors to the owning agent process and
 * self-terminates when it dies. Pass sessionId when the connection is attached, so
 * the poller also polls the session transcript for room context. Detached spawn
 * works uniformly across hosts — no per-tool nohup/run_in_background dance.
 */
export function ensurePollerForConnection(connectionId, opts = {}) {
  if (!connectionId || connectionId.length < 8) return { ok: false, error: 'missing connection id' }
  if (!fs.existsSync(POLLER_SCRIPT)) {
    return { ok: false, error: `poller script missing: ${POLLER_SCRIPT}` }
  }

  // Reuse a live poller instead of kill→respawn (item b9e02835). A running poller
  // needs NO restart for a session attach/detach — the server heartbeat echo is
  // its sole attachment authority — so a restart is only warranted when its
  // startup-cached identity (token / mcp_url / owner anchor) went stale. Callers
  // that verified nothing changed pass reuseRunning: true; with no live poller
  // this falls through to the normal spawn (and its guards) below.
  const findPids = opts.findPids || findPollerPidsForConnection
  if (opts.reuseRunning) {
    const running = findPids(connectionId)
    if (running.length) {
      return {
        ok: true,
        reused: true,
        connection_id: connectionId,
        session_id:
          typeof opts.sessionId === 'string' && opts.sessionId.length >= 8 ? opts.sessionId : null,
        pid: running[0],
        pid_file: pollerPidPath(connectionId),
        log: pollerLogPath(connectionId),
      }
    }
  }

  // Owner-process anchor — REQUIRED before we spawn anything. A poller with no
  // recorded owner_pid can never be proven dead by the reaper (owner-death is the
  // liveness proof it keys on), so it lingers as a zombie "Live" agent
  // (item 00bd4f6e). We refuse rather than fall back to process.ppid: inside this
  // short-lived state-writer subprocess ppid is the ephemeral invoking shell, not
  // the owning agent — recording it would make the reaper SIGTERM a LIVE agent's
  // poller the instant that shell exits. Callers pass the agent explicitly as
  // --owner-pid "$PPID" (POSIX: correct and cheap). On win32 that shell-reported
  // pid is commonly unusable (Git Bash's MSYS pid space isn't a real Win32 pid —
  // see resolveOwnerPidAutoWindows), so there we self-resolve by walking THIS
  // process's own (genuinely real) pid up to the owning claude.exe instead of
  // refusing (item 3cddb3b4). Injectable so tests get a deterministic "no anchor
  // found" case regardless of host OS or whether a real claude.exe happens to be
  // an ancestor of the test runner itself.
  const resolveOwnerPidFn = opts.resolveOwnerPid || resolveOwnerPid
  const ownerPid = resolveOwnerPidFn(opts.ownerPid, null)
  if (ownerPid === null) {
    return {
      ok: false,
      error:
        'refusing to spawn a poller without a valid --owner-pid (no trustworthy owner anchor → the reaper could never prove it dead → zombie "Live" agent). Pass --owner-pid "$PPID" (POSIX) — on Windows prefer omit or $PPID and let self-resolve walk to Cursor.exe/agent.exe/claude.exe or node.exe hosting cursor-agent; never pass a tool-shell $PID. If you see this, the automatic host walk failed too.',
    }
  }
  persistOwnerPidOnConnection(connectionId, ownerPid)

  const stopped = stopPollerForConnection(connectionId)
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })

  const logPath = pollerLogPath(connectionId)
  const pidPath = pollerPidPath(connectionId)
  const cwd = opts.cwd || process.cwd()
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.length >= 8 ? opts.sessionId : null

  let logFd
  try {
    logFd = fs.openSync(logPath, 'a')
  } catch (e) {
    return { ok: false, error: `could not open poll log: ${e.message}`, stopped }
  }

  const pollerArgs = [POLLER_SCRIPT, '--connection-id', connectionId]
  if (sessionId) pollerArgs.push('--session', sessionId)
  if (ownerPid) pollerArgs.push('--owner-pid', String(ownerPid))

  let child
  try {
    child = spawn(process.execPath, pollerArgs, {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: process.env,
    })
  } catch (e) {
    try {
      fs.closeSync(logFd)
    } catch {
      /* ignore */
    }
    return { ok: false, error: `spawn failed: ${e.message}`, stopped }
  }
  try {
    fs.closeSync(logFd)
  } catch {
    /* ignore */
  }
  child.unref()

  const pid = child.pid
  if (!pid) return { ok: false, error: 'spawn returned no pid', stopped }
  try {
    fs.writeFileSync(pidPath, `${pid}\n`, { mode: 0o600 })
  } catch (e) {
    return { ok: false, error: `wrote poller but failed pid file: ${e.message}`, pid, log: logPath, stopped }
  }

  return {
    ok: true,
    connection_id: connectionId,
    session_id: sessionId,
    pid,
    owner_pid: ownerPid,
    pid_file: pidPath,
    log: logPath,
    stopped,
  }
}

/**
 * Connection-scoped disable: mark this connection's state disabled, stop its poller,
 * and mark matching local bonds stopped. Shared by `disable` (explicit
 * --connection-id) and `disable-local` (SessionEnd, resolve connection from the
 * conversation bond). Never touches another connection's state or poller.
 */
function disableConnectionState(connectionId, { agent = null, localId = null } = {}) {
  const perPath = connectionPath(connectionId)
  const prev = readJson(perPath) || readJson(LEGACY_PATH) || {}
  const next = {
    ...prev,
    connection_id: connectionId,
    enabled: false,
    end_reason: prev.end_reason || 'local_stop',
    updated_at: new Date().toISOString(),
  }
  writeJson(perPath, next)
  // Update legacy only if it currently points at this connection (or is empty).
  const legacy = readJson(LEGACY_PATH)
  if (!legacy || !legacy.connection_id || legacy.connection_id === connectionId) {
    writeJson(LEGACY_PATH, next)
  }
  // Mark the exact conversation bond stopped (so soft-reconnect can find it).
  if (localId && agent) {
    const bond = readLocalBond(agent, localId)
    if (bond && bond.connection_id === connectionId) {
      writeLocalBond(agent, localId, {
        ...bond,
        status: 'stopped',
        end_reason: 'local_stop',
        connection_id: connectionId,
      })
    }
  }
  const bonds = markBondsStoppedForConnection(connectionId, 'local_stop')
  const killResult = stopPollerForConnection(connectionId)
  return {
    ok: true,
    enabled: false,
    connection_id: connectionId,
    path: perPath,
    poller: killResult,
    bonds_stopped: bonds.length,
  }
}

/** Owner (agent) process liveness — see devspec-remote-poll.mjs. EPERM = alive. */
export function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

/** Every per-connection state object on disk (raw). */
function scanConnectionStates() {
  const out = []
  try {
    if (!fs.existsSync(CONNECTIONS_DIR)) return out
    for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
      if (!f.endsWith('.json')) continue
      const s = readJson(path.join(CONNECTIONS_DIR, f))
      if (s && s.connection_id) out.push(s)
    }
  } catch {
    /* ignore */
  }
  return out
}

/**
 * Legacy backstop threshold. A still-running poller whose connection state carries
 * NO recorded owner_pid can't be proven dead by owner-death — this was the exact
 * zombie gap (item 00bd4f6e). New pollers always record an owner_pid
 * (ensurePollerForConnection refuses to spawn without one), so a live no-owner_pid
 * state is a pre-fix artifact. We reap it only once its local state has been
 * untouched this long, so a freshly-active legacy poller is never killed.
 */
const STALE_NO_OWNER_REAP_MS = 60 * 60 * 1000 // 1h

/**
 * Reap PROVABLY-DEAD pollers — the connect-time / SessionStart backstop for the
 * self-terminating poller. A poller is reaped when its connection is provably dead
 * (state disabled, ended-from-UI, or its recorded owner process is gone), so a live
 * sibling terminal's poller is NEVER touched. As a legacy safety net, a poller with
 * NO recorded owner_pid (pre-owner-pid-contract artifact — new spawns always record
 * one) is reaped only once its local state has gone stale beyond STALE_NO_OWNER_REAP_MS,
 * so a freshly-active one is left alone. Injectable for tests.
 */
export function reapDeadPollers({
  agent = AGENT_NAME,
  exceptConnectionId = null,
  now = Date.now(),
  staleNoOwnerReapMs = STALE_NO_OWNER_REAP_MS,
  listStates = scanConnectionStates,
  findPids = findPollerPidsForConnection,
  isOwnerAlive = ownerAlive,
  kill = (pid) => {
    try {
      process.kill(pid, 'SIGTERM')
      return true
    } catch {
      return false
    }
  },
} = {}) {
  const reaped = []
  for (const s of listStates()) {
    if (!s || !s.connection_id) continue
    if (exceptConnectionId && s.connection_id === exceptConnectionId) continue
    if (agent && s.agent_name && String(s.agent_name).toLowerCase() !== String(agent).toLowerCase()) {
      continue
    }
    const pids = findPids(s.connection_id)
    if (!pids.length) continue
    const ownerPid = Number.isInteger(s.owner_pid) && s.owner_pid > 1 ? s.owner_pid : null
    const ownerGone = ownerPid !== null && !isOwnerAlive(ownerPid)
    const provablyDead = s.enabled === false || s.ended_from_ui === true || ownerGone

    // Legacy backstop: with no owner_pid there is nothing to prove death by, so
    // reap only when the connection is still nominally enabled but its local state
    // has been untouched beyond the stale threshold (never a freshly-active one; a
    // missing/unparsable updated_at is treated as "unknown → leave alone").
    let staleNoOwner = false
    if (!provablyDead && ownerPid === null && s.enabled !== false && s.ended_from_ui !== true) {
      const t = Date.parse(s.updated_at || '')
      if (Number.isFinite(t) && now - t >= staleNoOwnerReapMs) staleNoOwner = true
    }

    if (!provablyDead && !staleNoOwner) continue
    const killed = pids.filter((pid) => kill(pid))
    reaped.push({
      connection_id: s.connection_id,
      agent_name: s.agent_name || null,
      killed,
      reason:
        s.enabled === false
          ? 'disabled'
          : s.ended_from_ui
            ? 'ended_from_ui'
            : ownerGone
              ? 'owner_gone'
              : 'stale_no_owner',
    })
  }
  return reaped
}

function agentSlug(name) {
  const s = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'agent'
}

function sanitizeLocalId(id) {
  if (id == null) return null
  const s = String(id).trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 128)
  return s || null
}

function localBondPath(agent, localId) {
  return path.join(LOCAL_DIR, agentSlug(agent), `${localId}.json`)
}

/**
 * Detect local conversation identity.
 * Prefer explicit arg / env that uniquely identifies this agent conversation.
 * Never use cwd.
 *
 * CONVERSATION-SCOPED IDS ONLY. Deliberately does NOT probe SHELL_SESSION_ID /
 * TERM_SESSION_ID: those identify the host TERMINAL, not this conversation, so one
 * shell running several conversations in sequence bonds them all to one id.
 *
 * The damage is worse than a wrong bond, because callers try env FIRST and fall back
 * to the host's own conversation id second (hooks: `resolveHookConversationId` reads
 * the stdin `session_id`). A shell id present in env HIJACKS that first leg and the
 * correct fallback is never reached. Stop then resolves a bond that matches no
 * connection, `selectBoundState` fails closed once 2+ connections of this agent are
 * live, the `.turn` marker is never cleared, and the poller re-asserts busy until
 * MAX_TURN_MS (1h). Live bug: Working / bouncing dots stuck after every remote reply
 * (Grok item a6b3f881, Claude item 87117120 — same root cause, both plugins).
 *
 * Tools with no per-conversation id at all (Cursor, Antigravity) correctly resolve
 * null here and are disambiguated by selectBoundState's single-connection fallback.
 */
export function detectLocalId(args = {}, env = process.env) {
  const fromArg = sanitizeLocalId(args['local-id'] || args.localId || args.local_id)
  if (fromArg) return { local_id: fromArg, source: 'arg' }

  const envPairs = [
    ['DEVSPEC_REMOTE_LOCAL_ID', env.DEVSPEC_REMOTE_LOCAL_ID],
    ['CURSOR_CONVERSATION_ID', env.CURSOR_CONVERSATION_ID],
    ['CODEX_THREAD_ID', env.CODEX_THREAD_ID],
    ['CLAUDE_CODE_SESSION_ID', env.CLAUDE_CODE_SESSION_ID],
    ['CLAUDE_SESSION_ID', env.CLAUDE_SESSION_ID],
    ['GROK_SESSION_ID', env.GROK_SESSION_ID],
    ['GROK_CONVERSATION_ID', env.GROK_CONVERSATION_ID],
  ]
  for (const [name, val] of envPairs) {
    const id = sanitizeLocalId(val)
    if (id) return { local_id: id, source: `env:${name}` }
  }
  return { local_id: null, source: null }
}

export function mintLocalId() {
  return crypto.randomUUID()
}

/**
 * Recoverable ends: this conversation may soft-reconnect its own prior connection
 * rather than registering a fresh one. Purely a LOCAL decision — the server has no
 * end_reason allowlist (resolveActiveConnection filters on `ended_at is null` only,
 * and a live heartbeat clears both columns), so this list is not mirrored anywhere.
 *
 * `owner_gone` MUST be here: it is the single most common way a Claude Code
 * conversation's poller dies (the host process exited), and it is exactly the case
 * where the user relaunches and expects their agent back. Omitting it would silently
 * downgrade every restart to a brand-new connection — a new codename on the Agents
 * page and a lost bond (item 937c78b0).
 *
 * UI end stops this poller process; a new instance may re-attach only with explicit --session.
 */
export function isRecoverableEndReason(endReason) {
  return (
    endReason === 'local_stop' ||
    endReason === 'owner_gone' ||
    endReason === 'idle_timeout' ||
    endReason === 'auth'
  )
}

function readLocalBond(agent, localId) {
  if (!localId) return null
  return readJson(localBondPath(agent, localId))
}

function writeLocalBond(agent, localId, patch) {
  const p = localBondPath(agent, localId)
  const prev = readJson(p) || {}
  const next = {
    ...prev,
    ...patch,
    local_id: localId,
    agent_name: patch.agent_name || prev.agent_name || agent,
    agent_slug: agentSlug(agent),
    updated_at: new Date().toISOString(),
  }
  writeJson(p, next)
  return next
}

/** Mark every local bond that points at connectionId as stopped. */
function markBondsStoppedForConnection(connectionId, endReason = 'local_stop') {
  const updated = []
  try {
    if (!fs.existsSync(LOCAL_DIR)) return updated
    for (const agentDir of fs.readdirSync(LOCAL_DIR)) {
      const dir = path.join(LOCAL_DIR, agentDir)
      let st
      try {
        st = fs.statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        const p = path.join(dir, f)
        const b = readJson(p)
        if (!b || b.connection_id !== connectionId) continue
        const next = {
          ...b,
          status: 'stopped',
          end_reason: endReason || b.end_reason || 'local_stop',
          updated_at: new Date().toISOString(),
        }
        writeJson(p, next)
        updated.push({ path: p, local_id: b.local_id, agent_name: b.agent_name })
      }
    }
  } catch {
    /* ignore */
  }
  return updated
}

/**
 * Resolve what bare /devspec.remote should do for THIS local conversation
 * (connection-native). Never scans by cwd.
 *
 * Actions:
 *   - create_and_attach — forceNew (--new): create a session then attach a connection.
 *   - already_live       — this conversation already owns a live connection: re-arm.
 *   - reconnect          — recent recoverable stop of this conversation's connection: resume.
 *   - register           — no/stale bond: register a fresh SESSIONLESS connection.
 */
export function resolveLocalAction({
  agent = AGENT_NAME,
  localId = null,
  forceNew = false,
  maxAgeMinutes = DEFAULT_RECONNECT_MAX_AGE_MINUTES,
  now = Date.now(),
  readBond = readLocalBond,
  readConnection = (id) => readJson(connectionPath(id)),
} = {}) {
  const agentName = agent || AGENT_NAME
  const maxAgeMs =
    Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES) * 60 * 1000
  const clampMax = Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES)

  if (forceNew) {
    return {
      ok: true,
      action: 'create_and_attach',
      found: false,
      local_id: localId || null,
      agent_name: agentName,
      connection_id: null,
      session_id: null,
      session_codename: null,
      title: null,
      end_reason: null,
      enabled: null,
      cursor_after_message_id: null,
      age_ms: null,
      max_age_minutes: clampMax,
      note: 'force-new: create a fresh session and attach a connection to it.',
    }
  }

  const bond = localId ? readBond(agentName, localId) : null
  if (!localId || !bond || !bond.connection_id) {
    return {
      ok: true,
      action: 'register',
      found: false,
      local_id: localId || null,
      agent_name: agentName,
      connection_id: null,
      session_id: null,
      session_codename: null,
      title: null,
      end_reason: null,
      enabled: null,
      cursor_after_message_id: null,
      age_ms: null,
      max_age_minutes: clampMax,
      note: !localId
        ? 'No local conversation id — register a fresh sessionless connection. Never rejoin by cwd/repo.'
        : 'No connection bond for this conversation — register a fresh sessionless connection.',
    }
  }

  const conn = readConnection(bond.connection_id) || {}
  const endReason = conn.end_reason || bond.end_reason || null
  const endedFromUi = conn.ended_from_ui === true || endReason === 'ui' || bond.end_reason === 'ui'
  const updatedAt = conn.updated_at || bond.updated_at || null
  const t = Date.parse(updatedAt || '')
  const ageMs = Number.isFinite(t) ? now - t : null

  const base = {
    ok: true,
    found: true,
    local_id: localId,
    agent_name: bond.agent_name || agentName,
    connection_id: bond.connection_id,
    session_id: bond.session_id || conn.session_id || null,
    session_codename: bond.session_codename || conn.session_codename || conn.codename || null,
    title: bond.title || conn.title || null,
    end_reason: endReason,
    enabled: conn.enabled !== false,
    cursor_after_message_id: conn.cursor_after_message_id || bond.cursor_after_message_id || null,
    updated_at: updatedAt,
    age_ms: ageMs,
    max_age_minutes: clampMax,
  }

  // Already live for this conversation — idempotent re-arm.
  if (bond.status === 'live' && conn.enabled !== false && !endedFromUi) {
    return {
      ...base,
      action: 'already_live',
      note: `This conversation is already connected as "${base.session_codename || bond.connection_id.slice(0, 8)}". Re-arm wait/poller; do not re-register.`,
    }
  }

  // Soft reconnect: same conversation, recent recoverable stop.
  if (
    !endedFromUi &&
    isRecoverableEndReason(endReason || bond.end_reason) &&
    ageMs != null &&
    ageMs <= maxAgeMs
  ) {
    return {
      ...base,
      action: 'reconnect',
      note: `Recent local stop of this conversation's connection "${base.session_codename || bond.connection_id.slice(0, 8)}" — resume it (re-register the same connection; reattach its session if any).`,
    }
  }

  // Stale / UI-ended / non-recoverable → fresh sessionless connection.
  return {
    ...base,
    action: 'register',
    found: true,
    connection_id: null, // do not auto-reuse the old connection
    session_id: null,
    prior_connection_id: bond.connection_id,
    prior_session_id: bond.session_id || null,
    note: endedFromUi
      ? 'Prior connection was ended from the UI. Register a fresh sessionless connection unless the user passed --session.'
      : ageMs != null && ageMs > maxAgeMs
        ? `Prior bond is older than ${base.max_age_minutes}m — register a fresh connection.`
        : 'Prior bond is not recoverable — register a fresh connection.',
  }
}

/**
 * Node-measured register_connection (item 383de0cd / mechanical Connect).
 * @param {{
 *   localId: string,
 *   projectId: string,
 *   cwd?: string,
 *   launchId?: string | null,
 *   agent?: string,
 *   hostToken?: string | null,
 *   codename?: string | null,
 *   gitRemote?: string | null,
 *   hostname?: string | null,
 *   mcpCall?: typeof mcpToolsCall,
 *   resolveAuth?: typeof resolveDevspecMcpAuth,
 *   emitPhase?: typeof emitConnectPhase,
 * }} opts
 */
export async function registerConnection(opts) {
  const started = Date.now()
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd()
  const localId = opts.localId
  const projectId = opts.projectId
  const launchId = resolveLaunchId(opts.launchId)
  const agent = opts.agent || AGENT_NAME
  const mcpCall = opts.mcpCall || mcpToolsCall
  const resolveAuth = opts.resolveAuth || resolveDevspecMcpAuth
  const emitPhase = opts.emitPhase || emitConnectPhase

  const hostToken =
    (typeof opts.hostToken === 'string' && opts.hostToken.trim()
      ? opts.hostToken.trim()
      : null) || hostTokenFromEnv(process.env)
  const auth = resolveAuth(cwd, { hostToken })
  if (!auth.ok || !auth.token || !auth.mcp_url) {
    await emitPhase({
      phase: 'register_connection',
      outcome: 'error',
      duration_ms: durationMs(started),
      launch_id: launchId,
      local_id: localId,
      agent,
      mcpUrl: auth.mcp_url || null,
      reason: auth.error || 'auth_failed',
    })
    return { ok: false, error: auth.error || 'auth_failed' }
  }

  const toolArgs = {
    local_id: localId,
    project_id: projectId,
    agent_name: agent,
    cwd,
    machine_hostname: opts.hostname || os.hostname(),
  }
  if (typeof opts.codename === 'string' && opts.codename.trim()) {
    toolArgs.codename = opts.codename.trim()
  }
  if (typeof opts.gitRemote === 'string' && opts.gitRemote.trim()) {
    toolArgs.git_remote = opts.gitRemote.trim()
  }

  try {
    const result = await mcpCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'register_connection',
      arguments: toolArgs,
      timeoutMs: 60_000,
    })
    const connectionId = result?.connection_id || result?.connectionId || null
    await emitPhase({
      phase: 'register_connection',
      outcome: connectionId ? 'ok' : 'error',
      duration_ms: durationMs(started),
      launch_id: launchId,
      local_id: localId,
      connectionId,
      sessionId: result?.session_id || null,
      agent,
      mcpUrl: auth.mcp_url,
      extra: {
        created: !!result?.created,
        codename: result?.codename || result?.session_codename || null,
      },
    })
    return {
      ok: !!connectionId,
      ...result,
      connection_id: connectionId,
      codename: result?.codename || result?.session_codename || null,
      local_id: localId,
      launch_id: launchId,
      ...(connectionId ? {} : { error: 'register_connection returned no connection_id' }),
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
    await emitPhase({
      phase: 'register_connection',
      outcome: 'error',
      duration_ms: durationMs(started),
      launch_id: launchId,
      local_id: localId,
      agent,
      mcpUrl: auth.mcp_url,
      reason,
    })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Node-measured attach_connection.
 * @param {{
 *   connectionId: string,
 *   sessionId: string,
 *   cwd?: string,
 *   launchId?: string | null,
 *   agent?: string,
 *   hostToken?: string | null,
 *   mcpCall?: typeof mcpToolsCall,
 *   resolveAuth?: typeof resolveDevspecMcpAuth,
 *   emitPhase?: typeof emitConnectPhase,
 * }} opts
 */
export async function attachConnection(opts) {
  const started = Date.now()
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd()
  const connectionId = opts.connectionId
  const sessionId = opts.sessionId
  const launchId = resolveLaunchId(opts.launchId)
  const agent = opts.agent || AGENT_NAME
  const mcpCall = opts.mcpCall || mcpToolsCall
  const resolveAuth = opts.resolveAuth || resolveDevspecMcpAuth
  const emitPhase = opts.emitPhase || emitConnectPhase

  const hostToken =
    (typeof opts.hostToken === 'string' && opts.hostToken.trim()
      ? opts.hostToken.trim()
      : null) || hostTokenFromEnv(process.env)
  const auth = resolveAuth(cwd, { hostToken })
  if (!auth.ok || !auth.token || !auth.mcp_url) {
    await emitPhase({
      phase: 'attach_connection',
      outcome: 'error',
      duration_ms: durationMs(started),
      launch_id: launchId,
      connectionId,
      sessionId,
      agent,
      mcpUrl: auth.mcp_url || null,
      reason: auth.error || 'auth_failed',
    })
    return { ok: false, error: auth.error || 'auth_failed' }
  }

  try {
    const result = await mcpCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'attach_connection',
      arguments: { connection_id: connectionId, session_id: sessionId },
      timeoutMs: 60_000,
    })
    await emitPhase({
      phase: 'attach_connection',
      outcome: 'ok',
      duration_ms: durationMs(started),
      launch_id: launchId,
      connectionId: result?.connection_id || connectionId,
      sessionId: result?.session_id || sessionId,
      agent,
      mcpUrl: auth.mcp_url,
      extra: { reattached: !!result?.reattached },
    })
    return {
      ok: true,
      ...result,
      connection_id: result?.connection_id || connectionId,
      session_id: result?.session_id || sessionId,
      launch_id: launchId,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
    await emitPhase({
      phase: 'attach_connection',
      outcome: 'error',
      duration_ms: durationMs(started),
      launch_id: launchId,
      connectionId,
      sessionId,
      agent,
      mcpUrl: auth.mcp_url,
      reason,
    })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Write connection state + conversation bond; auto-start poller unless noPoller.
 * Emits write_state connect_phase.
 * @param {{
 *   connectionId: string,
 *   sessionId?: string | null,
 *   cwd?: string,
 *   launchId?: string | null,
 *   agent?: string,
 *   localId?: string | null,
 *   ownerPid?: string | number | null,
 *   hostToken?: string | null,
 *   codename?: string | null,
 *   title?: string | null,
 *   url?: string | null,
 *   noPoller?: boolean,
 *   resolveAuth?: typeof resolveDevspecMcpAuth,
 *   emitPhase?: typeof emitConnectPhase,
 * }} opts
 */
export async function writeConnectionState(opts) {
  const writeStarted = Date.now()
  const connectionId = opts.connectionId
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd()
  const launchId = resolveLaunchId(opts.launchId)
  const resolveAuth = opts.resolveAuth || resolveDevspecMcpAuth
  const emitPhase = opts.emitPhase || emitConnectPhase

  const hostToken =
    (typeof opts.hostToken === 'string' && opts.hostToken.trim()
      ? opts.hostToken.trim()
      : null) || hostTokenFromEnv(process.env)
  const auth = resolveAuth(cwd, { hostToken })
  const prev = readJson(connectionPath(connectionId)) || {}
  const agentName = opts.agent || prev.agent_name || AGENT_NAME
  const localId =
    (typeof opts.localId === 'string' && opts.localId.trim()
      ? opts.localId.trim()
      : null) || detectLocalId({}, process.env).local_id
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.length >= 8
      ? opts.sessionId
      : prev.session_id ?? null
  const ownerPid = resolveOwnerPid(opts.ownerPid, prev.owner_pid)
  const state = {
    ...prev,
    enabled: true,
    connection_id: connectionId,
    session_id: sessionId,
    agent_name: agentName,
    local_id: localId ?? prev.local_id ?? null,
    owner_pid: ownerPid,
    mcp_url: opts.url || auth.mcp_url || prev.mcp_url || 'https://devspec.ai/api/mcp',
    token: auth.token || prev.token || undefined,
    auth_source: auth.source || auth.error || prev.auth_source || null,
    auth_ok: !!auth.ok || !!prev.auth_ok,
    cwd,
    session_codename: opts.codename || prev.session_codename || prev.codename || null,
    title: opts.title || prev.title || null,
    ended_from_ui: false,
    end_reason: null,
    updated_at: new Date().toISOString(),
  }
  const perPath = connectionPath(connectionId)
  writeJson(perPath, state)
  writeJson(LEGACY_PATH, state)

  let bond = null
  if (localId) {
    bond = writeLocalBond(agentName, localId, {
      status: 'live',
      connection_id: connectionId,
      session_id: sessionId,
      session_codename: state.session_codename,
      title: state.title,
      cwd,
      end_reason: null,
      cursor_after_message_id: prev.cursor_after_message_id || null,
    })
  }

  const result = {
    ok: !!state.auth_ok,
    path: perPath,
    legacy_path: LEGACY_PATH,
    connection_id: state.connection_id,
    session_id: state.session_id,
    session_codename: state.session_codename,
    title: state.title,
    mcp_url: state.mcp_url,
    auth_ok: state.auth_ok,
    auth_source: state.auth_source,
    token_present: !!state.token,
    local_id: localId,
    bond_path: bond ? localBondPath(agentName, localId) : null,
  }
  if (!state.auth_ok) {
    result.warning = auth.error
    result.error = auth.error || 'auth_failed'
  }
  if (!localId) {
    result.warning_local =
      'No --local-id / conversation env; soft-reconnect and already_live will not work until write is called with a local id.'
  }

  const wantPoller = state.auth_ok && !opts.noPoller
  if (wantPoller) {
    try {
      const reaped = reapDeadPollers({ agent: agentName, exceptConnectionId: connectionId })
      if (reaped.length) result.reaped = reaped
    } catch {
      /* non-fatal */
    }
    const reuseRunning =
      !!prev.token &&
      prev.token === state.token &&
      (prev.mcp_url || null) === (state.mcp_url || null) &&
      (Number(prev.owner_pid) || null) === (Number(state.owner_pid) || null)
    const poller = ensurePollerForConnection(connectionId, {
      cwd,
      ownerPid,
      sessionId,
      reuseRunning,
    })
    result.poller = poller
    if (!poller.ok) {
      result.warning_poller = poller.error
    }
  } else if (opts.noPoller) {
    result.poller = { ok: true, skipped: true, reason: 'no-poller' }
  }

  await emitPhase({
    phase: 'write_state',
    outcome: state.auth_ok ? 'ok' : 'error',
    duration_ms: durationMs(writeStarted),
    launch_id: launchId,
    local_id: localId || null,
    connectionId,
    sessionId,
    agent: agentName,
    mcpUrl: state.mcp_url || auth.mcp_url || null,
    reason: state.auth_ok ? null : auth.error || 'auth_failed',
    extra: {
      poller_started: !!(result.poller && result.poller.ok && !result.poller.skipped),
      auth_ok: !!state.auth_ok,
    },
  })

  return result
}

// --- CLI entry (skipped when imported for tests) ---
const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  void runCli().catch((err) => {
    process.stderr.write(`remote-control-state: ${err?.message || err}\n`)
    process.exit(1)
  })
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'read'
  const launchId = resolveLaunchId(args['launch-id'])

  if (cmd === 'fast-connect') {
    const { runFastConnectCli } = await import('./fast-connect.mjs')
    await runFastConnectCli(args)
    return
  }

  if (cmd === 'resolve-auth') {
    const hostToken =
      (typeof args['host-token'] === 'string' && args['host-token'].trim()
        ? args['host-token'].trim()
        : null) || hostTokenFromEnv(process.env)
    const auth = resolveDevspecMcpAuth(args.cwd || process.cwd(), { hostToken })
    if (process.argv.includes('--mask') && auth.token) {
      auth.token_preview = auth.token.slice(0, 8) + '…' + auth.token.slice(-4)
      delete auth.token
    }
    process.stdout.write(JSON.stringify(auth, null, 2) + '\n')
    process.exit(auth.ok ? 0 : 1)
  }

  /** Friendly unique channel labels (mirrors server generateRemoteControlCodename).
   *  First word: trait adjectives, colours, and motion verbs; second: animal.
   */
  const CODENAME_ADJECTIVES = [
    'Amber', 'Bold', 'Brave', 'Bright', 'Calm', 'Clever', 'Colorful', 'Cosmic',
    'Curious', 'Dapper', 'Daring', 'Eager', 'Ember', 'Fearless', 'Fierce', 'Gentle',
    'Hidden', 'Honest', 'Humble', 'Jolly', 'Keen', 'Lively', 'Lucky', 'Merry',
    'Mighty', 'Nimble', 'Noble', 'Patient', 'Playful', 'Proud', 'Quiet', 'Rapid',
    'Restless', 'Rusty', 'Silent', 'Steady', 'Sturdy', 'Swift', 'Velvet', 'Wary',
    'Wild', 'Witty', 'Zealous', 'Azure', 'Copper', 'Crimson', 'Emerald', 'Golden',
    'Green', 'Indigo', 'Ivory', 'Jade', 'Obsidian', 'Orange', 'Purple', 'Scarlet',
    'Silver', 'Teal', 'Violet', 'Bounding', 'Climbing', 'Dashing', 'Drifting', 'Flying',
    'Gliding', 'Leaping', 'Racing', 'Roaming', 'Running', 'Soaring', 'Sprinting', 'Vaulting',
    'Wandering',
  ]
  const CODENAME_ANIMALS = [
    'Alpaca', 'Badger', 'Beaver', 'Bison', 'Bobcat', 'Caracal', 'Condor', 'Coyote',
    'Crane', 'Crocodile', 'Dolphin', 'Dragonfly', 'Eagle', 'Egret', 'Falcon', 'Ferret',
    'Finch', 'Fox', 'Gecko', 'Gibbon', 'Hare', 'Hawk', 'Heron', 'Ibis',
    'Iguana', 'Jackal', 'Jaguar', 'Kestrel', 'Kingfisher', 'Koala', 'Lemur', 'Lizard',
    'Llama', 'Lynx', 'Mantis', 'Marten', 'Meerkat', 'Mongoose', 'Narwhal', 'Newt',
    'Ocelot', 'Octopus', 'Osprey', 'Otter', 'Owl', 'Panda', 'Panther', 'Pelican',
    'Penguin', 'Phoenix', 'Pika', 'Possum', 'Puma', 'Quail', 'Quokka', 'Rabbit',
    'Raccoon', 'Raven', 'Salmon', 'Seal', 'Sparrow', 'Squirrel', 'Stork', 'Tiger',
    'Toucan', 'Turtle', 'Urchin', 'Viper', 'Walrus', 'Weasel', 'Wombat', 'Wolf',
    'Yak', 'Zebra',
  ]

  function mintCodename() {
    const adj = CODENAME_ADJECTIVES[Math.floor(Math.random() * CODENAME_ADJECTIVES.length)]
    const animal = CODENAME_ANIMALS[Math.floor(Math.random() * CODENAME_ANIMALS.length)]
    return `${adj} ${animal}`
  }

  function listConnectionStates() {
    const out = []
    try {
      if (fs.existsSync(CONNECTIONS_DIR)) {
        for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
          if (!f.endsWith('.json')) continue
          const s = readJson(path.join(CONNECTIONS_DIR, f))
          if (s) {
            out.push({
              connection_id: s.connection_id || f.replace(/\.json$/, ''),
              session_id: s.session_id || null,
              enabled: s.enabled !== false,
              agent_name: s.agent_name || null,
              cwd: s.cwd || null,
              session_codename: s.session_codename || s.codename || null,
              title: s.title || null,
              end_reason: s.end_reason || null,
              ended_from_ui: s.ended_from_ui === true,
              cursor_after_message_id: s.cursor_after_message_id || null,
              updated_at: s.updated_at || null,
              path: path.join(CONNECTIONS_DIR, f),
            })
          }
        }
      }
    } catch {
      /* ignore */
    }
    return out
  }

  if (cmd === 'mint-codename') {
    const codename = mintCodename()
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          session_codename: codename,
          title_hint: codename,
          note: 'Pass session_codename (or title starting with this) to create_session; store on write --codename.',
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'mint-local-id') {
    const id = mintLocalId()
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          local_id: id,
          note: 'Store this for the entire local agent conversation. Pass --local-id on resolve-local / write / stop.',
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'resolve-local-id') {
    const started = Date.now()
    const detected = detectLocalId(args, process.env)
    const cwd = args.cwd || process.cwd()
    const auth = resolveDevspecMcpAuth(cwd)
    let payload
    if (detected.local_id) {
      payload = {
        ok: true,
        local_id: detected.local_id,
        source: detected.source,
        minted: false,
      }
    } else {
      const id = mintLocalId()
      payload = {
        ok: true,
        local_id: id,
        source: 'minted',
        minted: true,
        note: 'No conversation id in env. Hold this local_id in working memory for the rest of this agent chat; pass --local-id on every remote-control-state call.',
      }
    }
    await emitConnectPhase({
      phase: 'resolve_local_id',
      outcome: 'ok',
      duration_ms: durationMs(started),
      launch_id: launchId,
      local_id: payload.local_id,
      agent: args.agent || AGENT_NAME,
      mcpUrl: auth.mcp_url || null,
      extra: { local_id_source: payload.source, minted: payload.minted },
    })
    process.stdout.write(JSON.stringify(payload) + '\n')
    process.exit(0)
  }

  if (cmd === 'list') {
    const out = listConnectionStates()
    const legacy = readJson(LEGACY_PATH)
    const bonds = []
    try {
      if (fs.existsSync(LOCAL_DIR)) {
        for (const agentDir of fs.readdirSync(LOCAL_DIR)) {
          const dir = path.join(LOCAL_DIR, agentDir)
          if (!fs.statSync(dir).isDirectory()) continue
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue
            const b = readJson(path.join(dir, f))
            if (b) bonds.push(b)
          }
        }
      }
    } catch {
      /* ignore */
    }
    process.stdout.write(
      JSON.stringify(
        {
          connections: out,
          local_bonds: bonds,
          legacy: legacy
            ? {
                connection_id: legacy.connection_id || null,
                session_id: legacy.session_id || null,
                enabled: legacy.enabled,
                cwd: legacy.cwd || null,
                session_codename: legacy.session_codename || legacy.codename || null,
                title: legacy.title || null,
                end_reason: legacy.end_reason || null,
              }
            : null,
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'resolve-local' || cmd === 'find-reconnect') {
    // find-reconnect is a deprecated alias — same bond-scoped logic, never cwd scan.
    const started = Date.now()
    const agentName = args.agent || AGENT_NAME
    const detected = detectLocalId(args, process.env)
    const localId = detected.local_id
    const maxAgeMinutesRaw = args['max-age-minutes']
    const maxAgeMinutes = Math.max(
      1,
      Number.parseInt(String(maxAgeMinutesRaw ?? DEFAULT_RECONNECT_MAX_AGE_MINUTES), 10) ||
        DEFAULT_RECONNECT_MAX_AGE_MINUTES,
    )

    const result = resolveLocalAction({
      agent: agentName,
      localId,
      forceNew: !!args.forceNew,
      maxAgeMinutes,
    })

    result.cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
    result.local_id_source = detected.source
    result.candidates =
      result.action === 'reconnect' || result.action === 'already_live'
        ? [
            {
              connection_id: result.connection_id,
              session_id: result.session_id,
              agent_name: result.agent_name,
              session_codename: result.session_codename,
              title: result.title,
              enabled: result.enabled,
              end_reason: result.end_reason,
              age_ms: result.age_ms,
            },
          ]
        : []
    result.rejected = { no_local_id: !localId ? 1 : 0, cwd_scan_removed: 1 }

    const auth = resolveDevspecMcpAuth(result.cwd)
    await emitConnectPhase({
      phase: 'resolve_local',
      outcome: 'ok',
      duration_ms: durationMs(started),
      launch_id: launchId,
      local_id: localId || result.local_id || null,
      connectionId: result.connection_id || null,
      sessionId: result.session_id || null,
      agent: agentName,
      mcpUrl: auth.mcp_url || null,
      extra: { action: result.action },
    })

    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(0)
  }

  if (cmd === 'stop-poller') {
    const connectionId = args['connection-id']
    if (!connectionId) {
      process.stderr.write('Usage: remote-control-state.mjs stop-poller --connection-id <uuid>\n')
      process.exit(2)
    }
    const result = stopPollerForConnection(connectionId)
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
    process.exit(0)
  }

  if (cmd === 'read') {
    let s = null
    if (args['connection-id']) {
      s = readJson(connectionPath(args['connection-id']))
    }
    if (!s) {
      s = readJson(LEGACY_PATH)
      if (args['connection-id'] && s && s.connection_id && s.connection_id !== args['connection-id']) {
        s = null
      }
    }
    process.stdout.write(JSON.stringify(s, null, 2) + '\n')
    process.exit(s ? 0 : 1)
  }

  if (cmd === 'reap') {
    // Connect-time / SessionStart backstop: SIGTERM provably-dead pollers only.
    const agentName = args.agent || AGENT_NAME
    const reaped = reapDeadPollers({
      agent: agentName,
      exceptConnectionId: args['except-connection'] || args['connection-id'] || null,
    })
    process.stdout.write(
      JSON.stringify({ ok: true, agent: agentName, count: reaped.length, reaped }) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'ensure-poller' || cmd === 'start-poller') {
    const connectionId = args['connection-id']
    if (!connectionId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs ensure-poller --connection-id <uuid> [--session <uuid>] [--owner-pid <pid>] [--cwd <path>]\n',
      )
      process.exit(2)
    }
    const result = ensurePollerForConnection(connectionId, {
      cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
      ownerPid: args['owner-pid'],
      sessionId: args.session || null,
      // "ensure" semantics: a live poller for this connection already satisfies
      // the call — never restart it from here (item b9e02835).
      reuseRunning: true,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(result.ok ? 0 : 1)
  }

  if (cmd === 'disable') {
    // Connection-scoped disable. Without --connection-id, only disable legacy pointer.
    const connectionId = args['connection-id'] || readJson(LEGACY_PATH)?.connection_id
    if (!connectionId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs disable --connection-id <uuid>\n' +
          '(Required when multiple remotes may be active; refusing global kill.)\n',
      )
      process.exit(2)
    }
    const localId = detectLocalId(args, process.env).local_id
    const result = disableConnectionState(connectionId, { agent: args.agent, localId })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exit(0)
  }

  if (cmd === 'disable-local') {
    // SessionEnd teardown: resolve THIS conversation's bound connection (no
    // --connection-id needed) and disable it.
    const agentName = args.agent || AGENT_NAME
    let localId = detectLocalId(args, process.env).local_id
    // SessionEnd hook delivers the conversation id on stdin as { session_id }.
    if (!localId && !process.stdin.isTTY) {
      try {
        const raw = fs.readFileSync(0, 'utf8')
        const j = JSON.parse(raw || '{}')
        if (typeof j.session_id === 'string') localId = sanitizeLocalId(j.session_id)
      } catch {
        /* no stdin payload */
      }
    }
    const bond = localId ? readLocalBond(agentName, localId) : null
    const connectionId = bond?.connection_id || null
    if (!connectionId) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          skipped: 'no live bond for this conversation',
          local_id: localId || null,
        }) + '\n',
      )
      process.exit(0)
    }
    const result = disableConnectionState(connectionId, { agent: agentName, localId })
    process.stdout.write(JSON.stringify({ ...result, local_id: localId }) + '\n')
    process.exit(0)
  }

  if (cmd === 'write') {
    const connectionId = args['connection-id']
    if (!connectionId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs write --connection-id <uuid> [--session <uuid>]\n',
      )
      process.exit(2)
    }
    const localId = detectLocalId(args, process.env).local_id
    const hostToken =
      (typeof args['host-token'] === 'string' && args['host-token'].trim()
        ? args['host-token'].trim()
        : null) || hostTokenFromEnv(process.env)
    const result = await writeConnectionState({
      connectionId,
      sessionId: args.session || null,
      cwd: args.cwd || process.cwd(),
      launchId,
      agent: args.agent || AGENT_NAME,
      localId,
      ownerPid: args['owner-pid'],
      hostToken,
      codename: args.codename || null,
      title: args.title || null,
      url: args.url || null,
      noPoller: !!args.noPoller,
    })
    if (result.warning_poller) {
      process.stderr.write(`remote-control-state: ensure-poller failed — ${result.warning_poller}\n`)
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(result.ok ? 0 : 1)
  }

  if (cmd === 'register') {
    const localId = detectLocalId(args, process.env).local_id
    const projectId = typeof args['project-id'] === 'string' ? args['project-id'].trim() : ''
    if (!localId || !projectId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs register --local-id <id> --project-id <uuid> [--git-remote <url>] [--launch-id <uuid>]\n',
      )
      process.exit(2)
    }
    const hostToken =
      (typeof args['host-token'] === 'string' && args['host-token'].trim()
        ? args['host-token'].trim()
        : null) || hostTokenFromEnv(process.env)
    const result = await registerConnection({
      localId,
      projectId,
      cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
      launchId,
      agent: args.agent || AGENT_NAME,
      hostToken,
      codename: args.codename || null,
      gitRemote: args['git-remote'] || null,
      hostname: args.hostname || null,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(result.ok ? 0 : 1)
  }

  if (cmd === 'attach') {
    const connectionId = args['connection-id']
    const sessionId = args.session
    if (!connectionId || !sessionId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs attach --connection-id <uuid> --session <uuid> [--launch-id <uuid>]\n',
      )
      process.exit(2)
    }
    const hostToken =
      (typeof args['host-token'] === 'string' && args['host-token'].trim()
        ? args['host-token'].trim()
        : null) || hostTokenFromEnv(process.env)
    const result = await attachConnection({
      connectionId,
      sessionId,
      cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
      launchId,
      agent: args.agent || AGENT_NAME,
      hostToken,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(result.ok ? 0 : 1)
  }

  process.stderr.write(`Unknown command: ${cmd}\n`)
  process.exit(2)
}
