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
import { hasActiveTurnMarker, loadState, resolveHookConversationId } from './mirror-turn.mjs'
import { handleExplicitReply } from './mark-explicit-reply.mjs'
import {
  TRAIL_SEED_TEXT,
  advanceTrailState,
  isDevspecPostSessionTool,
  readTrailState,
  renderHookTrailPart,
  writeTrailState,
} from './work-trail.mjs'

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

async function main() {
  const modeArg = String(process.argv[2] || '')
  const mode = VALID_MODES.has(modeArg) ? modeArg : ''
  if (!mode) process.exit(0)

  const raw = readStdin()
  let data = {}
  try {
    data = JSON.parse(raw || '{}')
  } catch {
    data = {}
  }

  // Don't recurse when our own trail/answer MCP post fires mid-turn hooks; latch reply and clear turn marker if complete_turn.
  if (isDevspecPostSessionTool(data)) {
    try {
      await handleExplicitReply(raw, process.env)
    } catch {
      /* non-fatal */
    }
    process.exit(0)
  }

  const conversationId = resolveHookConversationId(raw, process.env)
  const fromHook =
    typeof data.conversation_id === 'string' && data.conversation_id.trim()
      ? data.conversation_id.trim()
      : null
  const bondId = conversationId || fromHook
  const state = loadState(bondId)
  if (!state?.enabled || !state.connection_id || !state.session_id) {
    process.exit(0)
  }

  // Mid-turn trail hooks (postToolUse, shell, MCP, etc.) must only emit trail updates
  // while a turn is actively marked running. Background IDE tool executions outside an
  // active turn must not assert busy state or open transient streaming bubbles.
  if (mode !== 'seed' && !hasActiveTurnMarker(state.connection_id)) {
    process.exit(0)
  }

  let token = state.mcp_token || state.token || null
  let mcpUrl = state.mcp_url || null
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) process.exit(0)
  mcpUrl = mcpUrl || 'https://devspec.ai/api/mcp'

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

  const prev = readTrailState(state.connection_id)
  const advanced = advanceTrailState({
    prev,
    part,
    mode,
    transcriptText,
  })
  if (!advanced) process.exit(0)

  writeTrailState(state.connection_id, {
    ...(prev || {}),
    cumulative: advanced.nextState.cumulative,
    lastPostedHash: advanced.nextState.lastPostedHash,
    lastPostedAt: advanced.nextState.lastPostedAt,
    updatedAt: advanced.nextState.updatedAt,
  })

  if (!advanced.shouldPost) process.exit(0)

  try {
    await mcpToolsCall({
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
  } catch (e) {
    process.stderr.write(
      `[devspec-remote] trail post failed: ${e instanceof Error ? e.message : String(e)}\n`,
    )
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
