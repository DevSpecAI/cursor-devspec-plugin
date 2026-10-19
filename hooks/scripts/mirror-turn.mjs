#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / UserPromptSubmit) — CONNECTION-NATIVE.
 * Resolves ONLY the connection bound to THIS local conversation — never a
 * machine-global "latest" pointer. Posts mechanically — no LLM tokens.
 *
 * user_prompt → optional local_prompt bubble when attached (literal owner text)
 *             → also seeds phase=trail "Working…" so the live bubble opens immediately
 * stop        → busy/heartbeat + turn marker only (NO assistant text); clears trail state
 *
 * Mid-turn trail growth lives in trail-turn.mjs (tool/shell/file/MCP hooks).
 * Answers are agent-canonical: skills call post_session_message({ connection_id }).
 * ADR b98a39a9 — no dual writers.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { detectLocalId } from './remote-control-state.mjs'
import { logRemoteControlStory } from './remote-control-story.mjs'
import { clearTrailState } from './work-trail.mjs'
import { clearInteractionContinuation } from './remote-control-state.mjs'
import { resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'
import {
  activeContinuation,
  continuationIdentity,
  turnEndInteractionDecision,
} from './interaction-events.mjs'
import { readConnectionCapability } from './manage-plan-bridge.mjs'
import { seedWorkTrailForConnection } from './seed-work-trail.mjs'
import { recordRuntimeReport } from './agent-telemetry.mjs'
import {
  absentLaunches,
  appendRequestEvent,
  closeRequest,
  launchForRequest,
  openRequest,
  promptArrival,
  readRequestState,
  requestFinished,
  requestForLaunch,
  requestsWithWorkPending,
  rotateRequestLog,
  UNSTATED,
} from './requests.mjs'
import { localTurnScope, localTurnToComplete, startLocalTurn } from './local-turn.mjs'
import { readTurnActivity, turnActivityPath, turnIsLive } from './turn-liveness.mjs'

const MODES = new Set(['user_prompt', 'stop', 'background_launch'])
const mode = MODES.has(process.argv[2]) ? process.argv[2] : 'stop'
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

function patchOwnState(connectionId, patch) {
  const file = path.join(CONNECTIONS_DIR, `${connectionId}.json`)
  if (!connectionId || !fs.existsSync(file)) return false
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!existing || typeof existing !== 'object') return false
    const next = { ...existing, ...patch, updated_at: new Date().toISOString() }
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

// Turn marker — the connected agent is the SOLE authority for the "working" state.
// UserPromptSubmit (turn start) writes it; Stop (turn end) clears it. The long-lived
// poller reads it (by connection_id) to re-assert busy on heartbeats while a turn
// runs, so long turns stay "working" and the server's busy freshness doesn't decay.
export function turnMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn`)
}
function readTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  try {
    const marker = JSON.parse(fs.readFileSync(turnMarkerPath(connectionId, dir), 'utf8'))
    return typeof marker?.startedAt === 'number' ? marker : null
  } catch {
    return null
  }
}
function markerIsLive(connectionId, marker, { dir = CONNECTIONS_DIR, now = Date.now() } = {}) {
  return turnIsLive(marker, { activity: readTurnActivity(connectionId, dir), now })
}
export function writeTurnMarker(connectionId, { held = false } = {}) {
  if (!connectionId) return
  const existing = readTurnMarker(connectionId)
  const startedAt = markerIsLive(connectionId, existing) ? existing.startedAt : Date.now()
  try {
    fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
    fs.writeFileSync(
      turnMarkerPath(connectionId),
      JSON.stringify(held ? { startedAt, held: true } : { startedAt }),
      { mode: 0o600 },
    )
  } catch {
    /* non-fatal — the immediate busy heartbeat below still fires */
  }
}
export function clearTurnMarker(connectionId) {
  if (!connectionId) return
  try {
    fs.rmSync(turnMarkerPath(connectionId), { force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(turnActivityPath(connectionId, CONNECTIONS_DIR), { force: true })
  } catch {
    /* ignore */
  }
}
export function hasActiveTurnMarker(connectionId, maxAgeMs) {
  if (!connectionId) return false
  try {
    const marker = readTurnMarker(connectionId)
    if (!marker) return false
    if (typeof maxAgeMs === 'number') {
      return Date.now() - marker.startedAt < maxAgeMs
    }
    return markerIsLive(connectionId, marker)
  } catch {
    return false
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The DevSpec connection to mirror for belongs to THIS local conversation. Resolve
 * its conversation id the SAME way remote-control-state.mjs `write` stamped it — via
 * the shared detectLocalId (probes whichever conversation-id env var THIS tool
 * exposes), then the hook stdin session_id. Tool-agnostic and SYMMETRIC with connect.
 */
export function resolveHookConversationId(hookInput, env = process.env) {
  // Cursor agent hooks stamp conversation_id — prefer that over env so CLI/IDE
  // mid-turn events bond correctly even when CURSOR_CONVERSATION_ID is absent.
  try {
    const parsed = JSON.parse(hookInput || '{}')
    if (typeof parsed.conversation_id === 'string' && parsed.conversation_id.trim()) {
      return parsed.conversation_id.trim()
    }
  } catch {
    /* fall through */
  }
  // Claude/Grok/Codex: env id is what remote-control-state write stamps.
  const fromEnv = detectLocalId({}, env).local_id
  if (fromEnv) return fromEnv
  try {
    const parsed = JSON.parse(hookInput || '{}')
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim()) {
      return parsed.session_id.trim()
    }
  } catch {
    /* fail closed */
  }
  return null
}

/**
 * Choose the connection state bound to THIS conversation.
 *
 * Primary — a precise conversation bond: tools that expose a stable conversation id
 * (Claude/Grok/Codex, via detectLocalId) select the state whose local_id matches.
 * A machine-newer connection for a DIFFERENT conversation is never picked.
 *
 * Fallback — for tools that expose NO per-conversation id to their hooks (Cursor,
 * Antigravity): the single enabled connection for THIS agent. Safe ONLY because
 * "exactly one" means nothing to disambiguate; two+ concurrent connections of the
 * same agent fall closed (no mirror) rather than guess.
 */
export function selectBoundState(candidates, conversationId, agentName = null) {
  const enabled = candidates
    .filter(Boolean)
    .filter(({ raw }) => raw?.enabled === true && raw?.connection_id)

  const isMine = ({ raw }) =>
    !agentName ||
    String(raw.agent_name || '').toLowerCase() === String(agentName).toLowerCase()

  if (conversationId) {
    // The agent check matters as much as the id. A conversation id is unique to
    // its host, not across hosts, so matching on the id ALONE means a plugin
    // that somehow resolved a foreign id would be handed that host's live
    // connection — and then post, claim and disable as them (item 75f65461).
    // detectLocalId no longer returns foreign ids, so this is belt and braces;
    // it is also the half that keeps holding if an id arrives by another route.
    const bound = enabled
      .filter(isMine)
      .filter(({ raw }) => raw.local_id === conversationId)
      .sort((a, b) => b.mtime - a.mtime)[0]?.raw
    if (bound) return bound
  }

  if (agentName) {
    const mine = enabled.filter(
      ({ raw }) => String(raw.agent_name || '').toLowerCase() === String(agentName).toLowerCase(),
    )
    if (mine.length === 1) return mine[0].raw
  }

  return null
}

/**
 * Marker set by mark-explicit-reply.mjs (PostToolUse on the devspec
 * post_session_message tool) when the agent itself already posted a reply this
 * turn. Checked here so Stop never ALSO mirrors the turn's end-of-turn
 * narration as a second, redundant session message (item b9fb49a9 — the
 * "double post, real reply missing" symptom was this narration landing
 * alongside an explicit reply, not instead of one). Cleared unconditionally
 * once read so it can never leak into a later turn.
 */
export function explicitReplyMarkerPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.explicit-reply`)
}
export function consumeExplicitReplyMarker(connectionId) {
  if (!connectionId) return false
  const p = explicitReplyMarkerPath(connectionId)
  try {
    const existed = fs.existsSync(p)
    if (existed) fs.rmSync(p, { force: true })
    return existed
  } catch {
    return false
  }
}

/**
 * Byte length of the space-free wake file Cursor's tail notifies from, or 0. The
 * follow appending past a recorded length is the proof an answer reached the chat.
 */
export function wakeFileBytesFor(connectionId) {
  try {
    return fs.statSync(resolveSpaceFreeWakeFile(connectionId)).size
  } catch {
    return 0
  }
}

export function loadState(conversationId) {
  // Gather every candidate (legacy singleton + per-connection files) but NEVER
  // trust "most recent" — selectBoundState keeps only THIS conversation's state.
  const candidates = []
  try {
    if (fs.existsSync(LEGACY_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
      candidates.push({ raw, mtime: fs.statSync(LEGACY_STATE_PATH).mtimeMs })
    }
  } catch {
    /* continue with per-connection state */
  }
  try {
    if (fs.existsSync(CONNECTIONS_DIR)) {
      for (const file of fs.readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith('.json'))) {
        try {
          const p = path.join(CONNECTIONS_DIR, file)
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
          candidates.push({ raw, mtime: fs.statSync(p).mtimeMs })
        } catch {
          /* ignore an incomplete or concurrently-replaced state file */
        }
      }
    }
  } catch {
    /* selection below fails closed when no readable matching state exists */
  }
  return selectBoundState(candidates, conversationId, AGENT_NAME)
}

function extractLastText(hookInput, which) {
  let data
  try {
    data = JSON.parse(hookInput || '{}')
  } catch {
    return null
  }

  if (which === 'user_prompt') {
    return (
      data.prompt ||
      data.user_prompt ||
      data.message ||
      data.text ||
      data.content ||
      (typeof data.input === 'string' ? data.input : null) ||
      null
    )
  }

  if (typeof data.last_assistant_message === 'string') return data.last_assistant_message
  if (typeof data.assistant_message === 'string') return data.assistant_message
  if (typeof data.response === 'string') return data.response
  if (typeof data.output === 'string') return data.output
  const msgs = data.transcript || data.messages
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m && (m.role === 'assistant' || m.type === 'assistant')) {
        const c = m.content
        if (typeof c === 'string' && c.trim()) return c
        if (Array.isArray(c)) {
          const text = c
            .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
            .map((b) => b.text || '')
            .join('\n')
            .trim()
          if (text) return text
        }
      }
    }
  }
  return null
}

/**
 * Claude Code and Cursor re-invoke the model after a background task or during harness setup
 * by injecting a synthetic user prompt (a <task-notification> block, a [SYSTEM NOTIFICATION …] banner,
 * a <system-reminder>, wait-tail instructions, etc.). Those are harness plumbing, never owner-typed
 * input, and must not assert busy or be mirrored as local_prompt bubbles.
 */
export function isHarnessInjection(text) {
  const t = String(text ?? '')
  return (
    t.includes('<task-notification') ||
    t.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]') ||
    t.includes('This is an automated background-task event') ||
    t.includes('<system-reminder>') ||
    t.includes('<system_reminder>') ||
    t.includes('<system-notification>') ||
    t.includes('<system_notification>') ||
    t.includes('Arm wait FIRST as a background Shell') ||
    t.includes('devspec-wake-tail.mjs') ||
    t.includes('devspec-remote-wait') ||
    /"type"\s*:\s*"(?:owner_message|automation_run|automation_dispatch|question_answer|question_dismissal|system_notice)"/.test(
      t,
    )
  )
}

const PROMPT_ORIGINS_OF_A_PERSON = new Set(['composer', 'bridge', 'sdk'])

/** The running turn a prompt was submitted into, or null. */
export function promptTurnId(hookInput) {
  try {
    const turnId = JSON.parse(hookInput || '{}')?.turn_id
    return typeof turnId === 'string' && turnId ? turnId : null
  } catch {
    return null
  }
}

export function promptOrigin(hookInput, text = null) {
  try {
    const kind = JSON.parse(hookInput || '{}')?.origin?.kind
    if (typeof kind === 'string') return kind
  } catch {
    /* fall through */
  }
  const t = String(text ?? '')
  if (!t.trim()) return null
  if (
    t.includes('<task-notification') ||
    t.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]') ||
    t.includes('This is an automated background-task event') ||
    /"type"\s*:\s*"(?:owner_message|automation_run|automation_dispatch|question_answer|question_dismissal|system_notice)"/.test(
      t,
    )
  ) {
    return 'task-notification'
  }
  if (!isHarnessInjection(t)) return 'composer'
  return null
}

/** True when a prompt came from a person (explicit composer/bridge/sdk origin or non-harness terminal prompt). */
export function promptCameFromAPerson(hookInput, text = null) {
  try {
    const parsed = JSON.parse(hookInput || '{}')
    if (parsed?.origin && typeof parsed.origin === 'object' && typeof parsed.origin.kind === 'string') {
      return PROMPT_ORIGINS_OF_A_PERSON.has(parsed.origin.kind)
    }
  } catch {
    return false
  }
  const resolved = text ?? extractLastText(hookInput, 'user_prompt')
  return Boolean(resolved && String(resolved).trim() && !isHarnessInjection(resolved))
}

export function parseBackgroundTasks(hookInput) {
  try {
    const data = JSON.parse(hookInput || '{}')
    return Array.isArray(data.background_tasks) ? data.background_tasks : null
  } catch {
    return null
  }
}

export function parseSessionCrons(hookInput) {
  try {
    const data = JSON.parse(hookInput || '{}')
    return Array.isArray(data.session_crons) ? data.session_crons : null
  } catch {
    return null
  }
}

/**
 * PostToolUse for a call that left work running or set up a wake: record which
 * request it belongs to (item 56ba1b79, requests.mjs), so the wake it causes later
 * continues that request.
 */
export function recordRequestLaunch(raw, { load = loadState, dir = CONNECTIONS_DIR } = {}) {
  let input
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return false
  }
  const toolName = input?.tool_name ?? input?.toolName ?? input?.tool ?? null
  const toolInput = input?.tool_input ?? input?.toolInput ?? input?.arguments ?? input?.args ?? null
  const toolResponse = input?.tool_response ?? input?.toolResponse ?? input?.result ?? input?.output ?? null
  const toolUseId = input?.tool_use_id ?? input?.toolUseId ?? input?.call_id ?? null
  const launch = launchForRequest(toolName, toolInput, toolResponse, toolUseId)
  if (!launch) return false
  const state = load(resolveHookConversationId(raw))
  if (!state?.connection_id) return false
  const agentId = typeof input?.agent_id === 'string' && input.agent_id ? input.agent_id : null
  const { request, also } = requestForLaunch(readRequestState(state.connection_id, { dir }), agentId)
  return launch.schedule
    ? appendRequestEvent(
        state.connection_id,
        { op: 'schedule', prompt: launch.prompt, id: launch.id, request, also },
        { dir },
      )
    : appendRequestEvent(
        state.connection_id,
        {
          op: 'launch',
          key: launch.key,
          alias: launch.alias,
          kind: launch.kind,
          notifies: launch.notifies,
          request,
          also,
        },
        { dir },
      )
}

const REMOTE_STATUS_BANNER = '━━━ DevSpec Remote Control ━━━'

/**
 * Strip the terminal status block agents often paste into Stop output.
 * Removes from the banner header through the trailing rule line.
 */
export function stripRemoteControlBanner(text) {
  const t = String(text ?? '')
  const start = t.indexOf(REMOTE_STATUS_BANNER)
  if (start < 0) return t
  const afterHeader = t.slice(start + REMOTE_STATUS_BANNER.length)
  // Prefer the unicode rule line used in skills; fall back to ASCII dashes.
  const ruleMatch = afterHeader.match(/\n[─-]{3,}\s*\n?/)
  let end = start + REMOTE_STATUS_BANNER.length
  if (ruleMatch && typeof ruleMatch.index === 'number') {
    end += ruleMatch.index + ruleMatch[0].length
  } else {
    // No rule line — drop from banner to end of that paragraph block.
    const nextBlank = afterHeader.search(/\n\s*\n/)
    end = nextBlank >= 0 ? start + REMOTE_STATUS_BANNER.length + nextBlank : t.length
  }
  return `${t.slice(0, start)}${t.slice(end)}`.replace(/^\s+|\s+$/g, '')
}

/**
 * True when Stop (or agent) text is operational chrome that must not become a
 * session chat bubble. Fail open for ambiguous / real replies.
 */
export function isOperationalChrome(text) {
  let t = String(text ?? '').trim()
  if (!t) return true

  if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
  if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
  if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true

  if (t.includes(REMOTE_STATUS_BANNER)) {
    t = stripRemoteControlBanner(t).trim()
    if (!t) return true
    if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true
    if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
    if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
    // Banner plus a tiny leftover (e.g. "Open: Agents page") — still chrome.
    if (t.length < 80 && /^(Agent|Connection|Session|Status|Open|Stop with):/m.test(t)) return true
  }

  return false
}

/**
 * Prepare agent Stop text for mirroring: strip known chrome; return null to skip.
 */
export function prepareAgentMirrorText(text) {
  let t = String(text ?? '').trim()
  if (!t) return null
  if (t.includes(REMOTE_STATUS_BANNER)) t = stripRemoteControlBanner(t).trim()
  if (!t || isOperationalChrome(t)) return null
  return t.slice(0, 12000)
}

async function main() {
  const raw = readStdin()
  if (mode === 'background_launch') {
    try {
      recordRequestLaunch(raw)
    } catch {
      /* an unrecorded launch only means its wake is credited as nobody's request */
    }
    process.exit(0)
  }

  const conversationId = resolveHookConversationId(raw)
  const state = loadState(conversationId)
  if (!state) process.exit(0)

  let token = state.token
  let mcpUrl = state.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) process.exit(0) // silent — skill still posts instructionally

  mcpUrl = mcpUrl || 'https://api.devspec.ai/api/mcp'
  // Identity is a fixed property of THIS plugin — never trust state/args for it.
  const agentName = AGENT_NAME
  const connectionId = state.connection_id
  const sessionId = state.session_id || null // null = sessionless (no room to mirror into)
  const localId = state.local_id || null
  const connectionCapability = state.connection_capability || readConnectionCapability(connectionId)
  const callRequest = (args, timeoutMs = 5_000) =>
    mcpToolsCall({
      mcpUrl,
      token,
      connectionCapability,
      name: 'report_request',
      arguments: args,
      timeoutMs,
    })

  // The model Cursor says this turn runs, for the Agents page (item cc47378e).
  recordRuntimeReport(connectionId, raw)

  const text = extractLastText(raw, mode)
  const fromAPerson = mode === 'user_prompt' && promptCameFromAPerson(raw, text)
  const origin = mode === 'user_prompt' ? promptOrigin(raw, text) : null
  const skipMirror = mode === 'user_prompt' && (!text || !String(text).trim() || !fromAPerson)

  let typedRequest = null
  if (mode === 'user_prompt' && connectionId && (fromAPerson || origin)) {
    try {
      const midTurn = promptTurnId(raw) !== null
      const arrival = promptArrival({
        fromAPerson: fromAPerson && Boolean(text && String(text).trim()),
        origin,
        text,
        midTurn,
        state: readRequestState(connectionId, { dir: CONNECTIONS_DIR }),
      })
      for (const event of arrival.events) appendRequestEvent(connectionId, event, { dir: CONNECTIONS_DIR })
      if (arrival.typedId) typedRequest = { id: arrival.typedId, midTurn }
    } catch {
      /* an unrecorded request only leaves DevSpec to resolve who asked itself */
    }
  }

  // Consume any explicit-reply marker so it cannot bleed into a later turn.
  // Agent answers are skill-posted (ADR b98a39a9); Stop no longer mirrors full
  // assistant text as a primary path — dual writers caused wrong-voice dupes
  // and silent misses when bonding failed.
  if (mode === 'stop') consumeExplicitReplyMarker(connectionId)

  // Skip turn marker, work trail seed, local prompt mirroring, and busy assertion
  // when user_prompt has no genuine user text or is harness injection (prevents transient dot flicker).
  if (mode === 'user_prompt' && skipMirror) {
    process.exit(0)
  }

  try {
    // A prompt typed at this terminal opens the owner's own turn, admitted with the
    // connection capability BEFORE the model starts, so every write it makes names
    // the owner as the person who asked (item b59a201c, local-turn.mjs). Nothing
    // else does: a room command carries its own requester, a background wake
    // continues the turn that is already open, and a scheduled firing was asked for
    // by nobody at this moment.
    if (fromAPerson && connectionId && sessionId && text && String(text).trim()) {
      const scope = localTurnScope(
        { ...state, connection_capability: connectionCapability },
        sessionId,
      )
      if (scope) {
        const admitted = await startLocalTurn({
          scope,
          previousAttemptId: state.local_turn?.attempt_id ?? null,
          call: (args) =>
            mcpToolsCall({
              mcpUrl,
              token,
              connectionCapability,
              name: 'report_pickup',
              arguments: args,
              timeoutMs: 10_000,
            }),
        })
        if (admitted) patchOwnState(connectionId, { local_turn: admitted })
      }
    }

    if (typedRequest && connectionCapability) {
      const opened = await openRequest({
        connectionId,
        kind: 'typed_prompt',
        call: callRequest,
        dir: CONNECTIONS_DIR,
        id: typedRequest.id,
      }).catch(() => null)
      if (!opened && typedRequest.midTurn) {
        appendRequestEvent(connectionId, { op: 'joined', id: UNSTATED }, { dir: CONNECTIONS_DIR })
      }
    }

    // LOCAL PROMPT only: mirror owner text typed in the terminal into the room
    // when attached (two-sided transcript). Agent Stop text is NOT posted here —
    // the skill must post_session_message the direct answer (prefer connection_id).
    if (
      mode === 'user_prompt' &&
      sessionId &&
      text &&
      String(text).trim()
    ) {
      const cleaned = String(text).trim().slice(0, 12000)
      if (cleaned) {
        const postArgs = {
          message: cleaned,
          agent_name: agentName,
          turn_kind: 'local_prompt',
        }
        // Prefer connection_id so reattach is server-resolved (delivery contract).
        if (connectionId) postArgs.connection_id = connectionId
        else postArgs.session_id = sessionId
        await mcpToolsCall({
          mcpUrl,
          token,
          name: 'post_session_message',
          arguments: postArgs,
          timeoutMs: 15_000,
        })
      }
    }

    // Seed the live work-trail bubble when attached (OpenCode parity). Mid-turn
    // hooks grow it; the model's phase=answer + complete_turn collapses it.
    // Shared with the poller's remote-wake seed (phone/web never hits user_prompt).
    if (mode === 'user_prompt' && sessionId && connectionId) {
      try {
        await seedWorkTrailForConnection({
          connectionId,
          mcpUrl,
          token,
          agentName,
        })
      } catch {
        /* non-fatal — final answer path still works without a trail seed */
      }
    }

    if (mode === 'stop' && connectionId) clearTrailState(connectionId)

    // Turn lifecycle → "working" authority. user_prompt starts a turn (busy:true +
    // marker so the poller re-asserts); stop ends it (busy:false + clear marker).
    // Marker is keyed by connection_id (the poller reads it by connection_id).
    const turnActive = mode === 'user_prompt'
    let stopDecisionAction = null
    if (turnActive) writeTurnMarker(connectionId)
    else clearTurnMarker(connectionId)

    // Busy heartbeat — one connection-native path (attached or sessionless). The
    // server broadcasts agent_status for the attached session, so no session-keyed
    // heartbeat is needed.
    if (connectionId) {
      await mcpToolsCall({
        mcpUrl,
        token,
        name: 'heartbeat_connection',
        arguments: {
          connection_id: connectionId,
          agent_name: agentName,
          status: 'live',
          busy: turnActive,
        },
        timeoutMs: 15_000,
      })
      // End the activity attempt immediately on Stop. The poller also emits
      // report_complete when the marker disappears, but that waits for the next
      // long-poll tick — so Working / dots linger for seconds after the answer has
      // already landed. Calling it here drops them as soon as the turn ends, and
      // means a healthy Stop no longer depends on the poller to finish the turn.
      //
      // An exact directed-question attempt is the ONE case the generic call must not
      // touch: closing an attempt from outside its claim generation is how a Cursor
      // turn was sealed empty while the model was still inside it. It gets its own
      // exact completion, and only once its answer has actually reached the chat.
      if (!turnActive) {
        const decision = turnEndInteractionDecision({
          continuation: activeContinuation(state.interaction_continuation, {
            connectionId,
            sessionId,
          }),
          wakeFileBytes: wakeFileBytesFor(connectionId),
        })
        // 'hold' completes nothing at all: the answer is still in flight, and closing
        // the connection's current attempt now would close THAT one. The window is the
        // follow's poll interval, and the turn the answer starts owns the completion.
        stopDecisionAction = decision.action
        if (decision.action !== 'hold') {
          const localAttempt = localTurnToComplete(state.local_turn, sessionId)
          try {
            await mcpToolsCall({
              mcpUrl,
              token,
              ...(decision.action === 'complete'
                ? { connectionCapability }
                : {}),
              name: 'report_complete',
              arguments: decision.action === 'complete'
                ? {
                    connection_id: connectionId,
                    attempt_id: decision.continuation.attempt_id,
                    reason: 'turn_end',
                    ...continuationIdentity(decision.continuation),
                  }
                : localAttempt
                  ? { connection_id: connectionId, attempt_id: localAttempt, reason: 'turn_end' }
                  : { connection_id: connectionId, reason: 'turn_end' },
              timeoutMs: 15_000,
            })
            if (decision.action === 'complete') clearInteractionContinuation(connectionId)
            logRemoteControlStory({
              phase: 'complete_turn',
              outcome: 'completed',
              connectionId,
              agent: agentName || AGENT_NAME,
              tool: 'mirror-turn.stop',
              reason: decision.action === 'complete' ? 'exact_interaction_turn_end' : 'turn_end',
            })
          } catch {
            /* non-fatal — the poller's marker-driven backstop still runs */
          }
          if (state.local_turn) patchOwnState(connectionId, { local_turn: null })
        }
      }
    }

    if (mode === 'stop' && connectionId && connectionCapability) {
      const requests = readRequestState(connectionId, { dir: CONNECTIONS_DIR })
      const backgroundTasks = parseBackgroundTasks(raw)
      if (requests.open.size > 0) {
        const pending = requestsWithWorkPending(requests, {
          backgroundTasks,
          sessionCrons: parseSessionCrons(raw),
        })
        const awaitingAnswer = stopDecisionAction === 'hold' ? requests.current : null
        const finished = [...requests.open.keys()].filter(
          (id) => requestFinished(requests, id, pending) && id !== awaitingAnswer,
        )
        await Promise.all(
          finished.map((requestId) =>
            closeRequest({
              connectionId,
              requestId,
              call: (args) => callRequest(args, 3_000),
              dir: CONNECTIONS_DIR,
            }),
          ),
        )
      }
      for (const key of absentLaunches(requests, backgroundTasks)) {
        appendRequestEvent(connectionId, { op: 'absent', key }, { dir: CONNECTIONS_DIR })
      }
      rotateRequestLog(connectionId, { dir: CONNECTIONS_DIR })
    }
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
