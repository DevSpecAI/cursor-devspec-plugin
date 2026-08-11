#!/usr/bin/env node
/**
 * CLI-safe work-trail growth for Cursor Agents remote control.
 *
 * Cursor CLI interactive `--resume` sessions often never invoke mid-turn hooks
 * from ~/.cursor/hooks.json (tool/shell/MCP/thought). trail-turn.mjs works when
 * piped manually, but automatic hooks do not fire — Show work stays at a seed
 * or a single model one-liner.
 *
 * This watcher tails the on-disk agent transcript for the bonded conversation
 * and posts throttled phase=trail updates while the connection turn marker is
 * fresh. The continuous poller starts it on owner-command pickup.
 *
 * Usage:
 *   node cli-trail-watch.mjs --connection-id <uuid> [--poll-ms 800] [--idle-exit-ms 45000]
 *
 * Exit 0 when the turn ends / connection stops / max runtime.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { postTrailFromTranscript } from './post-trail-from-transcript.mjs'
import { resolveAgentTranscriptPath } from './work-trail.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const DEFAULT_POLL_MS = 800
const DEFAULT_IDLE_EXIT_MS = 45_000
const MAX_RUNTIME_MS = 6 * 60 * 60 * 1000

function parseArgs(argv) {
  const out = {
    connectionId: null,
    pollMs: DEFAULT_POLL_MS,
    idleExitMs: DEFAULT_IDLE_EXIT_MS,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if ((a === '--connection-id' || a === '--connection_id') && argv[i + 1]) {
      out.connectionId = argv[++i]
    } else if (a === '--poll-ms' && argv[i + 1]) {
      out.pollMs = Math.max(250, Number(argv[++i]) || DEFAULT_POLL_MS)
    } else if (a === '--idle-exit-ms' && argv[i + 1]) {
      out.idleExitMs = Math.max(5_000, Number(argv[++i]) || DEFAULT_IDLE_EXIT_MS)
    }
  }
  return out
}

export function trailWatchPidPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.trail-watch.pid`)
}

export function turnMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn`)
}

export function readConnectionState(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${connectionId}.json`), 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

export function isTurnActive(connectionId, dir = CONNECTIONS_DIR) {
  try {
    return fs.existsSync(turnMarkerPath(connectionId, dir))
  } catch {
    return false
  }
}

export function isWatchPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure a single detached transcript watcher for this connection.
 * Idempotent — skips if a live pid file already points at a running process.
 * @returns {{ started: boolean, skipped?: boolean, reason?: string, pid?: number }}
 */
export function ensureCliTrailWatch({
  connectionId,
  scriptPath = fileURLToPath(import.meta.url),
  spawnFn = spawn,
  dir = CONNECTIONS_DIR,
} = {}) {
  const id = String(connectionId || '').trim()
  if (!id) return { started: false, skipped: true, reason: 'missing_connection_id' }

  const pidPath = trailWatchPidPath(id, dir)
  try {
    const prev = Number(fs.readFileSync(pidPath, 'utf8').trim())
    if (isWatchPidAlive(prev)) {
      return { started: false, skipped: true, reason: 'already_running', pid: prev }
    }
  } catch {
    /* no prior pid */
  }

  fs.mkdirSync(dir, { recursive: true })
  const child = spawnFn(process.execPath, [scriptPath, '--connection-id', id], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  const pid = child.pid
  try {
    child.unref()
  } catch {
    /* ignore */
  }
  if (!pid) return { started: false, skipped: true, reason: 'spawn_failed' }
  try {
    fs.writeFileSync(pidPath, String(pid), { mode: 0o600 })
  } catch {
    /* non-fatal */
  }
  return { started: true, pid }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const connectionId = args.connectionId
  if (!connectionId) {
    process.stderr.write('cli-trail-watch: --connection-id required\n')
    process.exit(2)
  }

  const startedAt = Date.now()
  let idleSince = null
  let lastSize = -1
  let lastMtimeMs = -1

  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    const state = readConnectionState(connectionId)
    if (!state || state.enabled === false) break

    const turnActive = isTurnActive(connectionId)
    if (!turnActive) {
      if (idleSince == null) idleSince = Date.now()
      else if (Date.now() - idleSince >= args.idleExitMs) break
      await sleep(args.pollMs)
      continue
    }
    idleSince = null

    if (!state.session_id) {
      await sleep(args.pollMs)
      continue
    }

    const localId = typeof state.local_id === 'string' ? state.local_id.trim() : ''
    if (!localId) {
      await sleep(args.pollMs)
      continue
    }

    const transcriptPath = resolveAgentTranscriptPath(localId)
    if (!transcriptPath) {
      await sleep(args.pollMs)
      continue
    }

    let st
    try {
      st = fs.statSync(transcriptPath)
    } catch {
      await sleep(args.pollMs)
      continue
    }

    const grew = st.size !== lastSize || st.mtimeMs !== lastMtimeMs
    lastSize = st.size
    lastMtimeMs = st.mtimeMs
    if (!grew) {
      await sleep(args.pollMs)
      continue
    }

    let token = state.mcp_token || state.token || null
    let mcpUrl = state.mcp_url || null
    if (!token) {
      const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
      token = auth.token
      mcpUrl = mcpUrl || auth.mcp_url
    }
    mcpUrl = mcpUrl || 'https://devspec.ai/api/mcp'
    if (!token) {
      await sleep(args.pollMs)
      continue
    }

    try {
      await postTrailFromTranscript({
        connectionId,
        mcpUrl,
        token,
        localId,
        transcriptPath,
        agentName: AGENT_NAME,
      })
    } catch (e) {
      process.stderr.write(
        `cli-trail-watch: post failed: ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }

    await sleep(args.pollMs)
  }

  try {
    const pidPath = trailWatchPidPath(connectionId)
    const claimed = Number(fs.readFileSync(pidPath, 'utf8').trim())
    if (claimed === process.pid) fs.rmSync(pidPath, { force: true })
  } catch {
    /* ignore */
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`cli-trail-watch: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
