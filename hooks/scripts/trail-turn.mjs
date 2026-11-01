#!/usr/bin/env node
/**
 * Mid-turn work-trail hook — CONNECTION-NATIVE.
 *
 * Fired by Cursor tool/shell/file/MCP hooks while a remote-control turn runs.
 * Posts throttled `phase=trail` updates so DevSpec can grow one live Working
 * bubble (OpenCode parity). Final answers stay agent-canonical (model posts
 * phase=answer + complete_turn); this script never posts assistant answers.
 *
 * Modes (argv[2]): seed | postToolUse | postToolUseFailure | afterShellExecution |
 * beforeShellExecution | afterMCPExecution | beforeMCPExecution | afterFileEdit |
 * afterAgentThought
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { readActiveTurnMarker, loadState, resolveHookConversationId } from './mirror-turn.mjs'
import { handleExplicitReply } from './mark-explicit-reply.mjs'
import {
  TRAIL_SEED_TEXT,
  advanceTrailState,
  isDevspecPostSessionTool,
  readTrailState,
  renderHookTrailPart,
  writeTrailState,
} from './work-trail.mjs'
import { recordTurnActivity } from './turn-liveness.mjs'
import { currentTurnNoticeIds } from './notice-reply.mjs'
import { recordRuntimeReport } from './agent-telemetry.mjs'

const VALID_MODES = new Set([
  'seed',
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'beforeShellExecution',
  'afterMCPExecution',
  'beforeMCPExecution',
  'afterFileEdit',
  'afterAgentThought',
])

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export async function runTrailTurn({
  modeArg = '',
  raw = '',
  env = process.env,
  connectionsDir,
  loadStateFn = loadState,
  call = mcpToolsCall,
  now = Date.now(),
} = {}) {
  const mode = VALID_MODES.has(String(modeArg || '')) ? String(modeArg) : ''
  if (!mode) return { ok: false, skipped: true, reason: 'invalid_mode' }

  let data = {}
  try {
    data = JSON.parse(raw || '{}')
  } catch {
    data = {}
  }

  // Don't recurse when our own trail/answer MCP post fires mid-turn hooks; latch reply and clear turn marker if complete_turn.
  if (isDevspecPostSessionTool(data)) {
    try {
      await handleExplicitReply(raw, env)
    } catch {
      /* non-fatal */
    }
    return { ok: false, skipped: true, reason: 'self_post' }
  }

  const conversationId = resolveHookConversationId(raw, env)
  const fromHook =
    typeof data.conversation_id === 'string' && data.conversation_id.trim()
      ? data.conversation_id.trim()
      : null
  const bondId = conversationId || fromHook
  const state = loadStateFn(bondId)
  if (!state?.enabled || !state.connection_id) {
    return { ok: false, skipped: true, reason: 'disabled_or_unbound' }
  }
  // The model this tool call runs, for the Agents page (item 30cd0424). Every Cursor hook
  // names it. The prompt-submit and stop hooks also report it, but neither is dependable
  // for a connected conversation (measured on cursor-agent 2026.10.22): prompt-submit runs
  // only for a prompt typed in the terminal, never for a room command, and stop is skipped
  // whenever Cursor ends a turn on its own "WritableIterable is closed" error, which it did
  // after nearly every turn of a long remote-driven session. So no model ever arrived.
  recordRuntimeReport(state.connection_id, raw, connectionsDir ? { dir: connectionsDir, now: new Date(now) } : { now: new Date(now) })
  if (mode === 'seed' && !state.session_id) {
    return { ok: false, skipped: true, reason: 'seed_requires_session' }
  }

  // Mid-turn trail hooks (postToolUse, shell, MCP, etc.) must only emit trail updates
  // while a turn is actively marked running, and sessionless connections only stream
  // during server-dispatched remote/automation turns (never unattached local turns).
  if (mode !== 'seed') {
    const activeMarker = readActiveTurnMarker(state.connection_id, {
      ...(connectionsDir ? { dir: connectionsDir } : {}),
      now,
    })
    if (!activeMarker) {
      return { ok: false, skipped: true, reason: 'no_active_turn' }
    }
    if (!state.session_id && !activeMarker.remoteTurn) {
      return { ok: false, skipped: true, reason: 'unattached_local_turn' }
    }
  }
  // A turn woken only by DevSpec notices belongs to no command, so its work is never
  // posted as a trail, which DevSpec would file under someone's command (notice-reply.mjs).
  if (
    currentTurnNoticeIds(state.connection_id, {
      ...(connectionsDir ? { dir: connectionsDir } : {}),
      connectionState: state,
    })
  ) {
    return { ok: false, skipped: true, reason: 'notice_turn' }
  }
  if (mode !== 'seed') {
    recordTurnActivity(state.connection_id, connectionsDir ? { dir: connectionsDir } : undefined)
  }

  let token = state.mcp_token || state.token || null
  let mcpUrl = state.mcp_url || null
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) return { ok: false, skipped: true, reason: 'no_token' }
  mcpUrl = mcpUrl || 'https://api.devspec.ai/api/mcp'

  const part = mode === 'seed' ? TRAIL_SEED_TEXT : renderHookTrailPart(mode, data)
  let transcriptText = null
  const transcriptPath =
    typeof data.transcript_path === 'string' && data.transcript_path.trim()
      ? data.transcript_path.trim()
      : null
  if (transcriptPath && mode !== 'seed') {
    try {
      transcriptText = fs.readFileSync(transcriptPath, 'utf8')
    } catch {
      transcriptText = null
    }
  }

  const prev = readTrailState(state.connection_id, connectionsDir)
  const advanced = advanceTrailState({
    prev,
    part,
    mode,
    now,
    transcriptText,
  })
  if (!advanced) return { ok: false, skipped: true, reason: 'no_advance' }

  if (!advanced.shouldPost) {
    writeTrailState(
      state.connection_id,
      {
        ...(prev || {}),
        cumulative: advanced.nextState.cumulative,
        lastPostedHash: prev?.lastPostedHash ?? null,
        lastPostedAt: prev?.lastPostedAt ?? null,
        updatedAt: advanced.nextState.updatedAt,
      },
      connectionsDir,
    )
    return { ok: false, skipped: true, reason: 'throttle', trail: advanced.trail }
  }

  try {
    const res = await call({
      mcpUrl,
      token,
      name: 'post_session_message',
      arguments: {
        connection_id: state.connection_id,
        message: advanced.trail,
        agent_name: AGENT_NAME,
        turn_kind: 'agent',
        phase: 'trail',
      },
      timeoutMs: 15_000,
    })
    if (res?.isError === true || res?.result?.isError === true) {
      writeTrailState(
        state.connection_id,
        {
          ...(prev || {}),
          cumulative: advanced.nextState.cumulative,
          lastPostedHash: prev?.lastPostedHash ?? null,
          lastPostedAt: prev?.lastPostedAt ?? null,
          updatedAt: advanced.nextState.updatedAt,
        },
        connectionsDir,
      )
      return { ok: false, skipped: true, reason: 'server_refused' }
    }
    writeTrailState(
      state.connection_id,
      {
        ...(prev || {}),
        cumulative: advanced.nextState.cumulative,
        lastPostedHash: advanced.nextState.lastPostedHash,
        lastPostedAt: advanced.nextState.lastPostedAt,
        updatedAt: advanced.nextState.updatedAt,
      },
      connectionsDir,
    )
    return { ok: true, trail: advanced.trail }
  } catch (e) {
    writeTrailState(
      state.connection_id,
      {
        ...(prev || {}),
        cumulative: advanced.nextState.cumulative,
        lastPostedHash: prev?.lastPostedHash ?? null,
        lastPostedAt: prev?.lastPostedAt ?? null,
        updatedAt: advanced.nextState.updatedAt,
      },
      connectionsDir,
    )
    process.stderr.write(
      `[devspec-remote] trail post failed: ${e instanceof Error ? e.message : String(e)}\n`,
    )
    return { ok: false, skipped: true, reason: 'post_error' }
  }
}

async function main() {
  await runTrailTurn({
    modeArg: String(process.argv[2] || ''),
    raw: readStdin(),
    env: process.env,
  })
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
