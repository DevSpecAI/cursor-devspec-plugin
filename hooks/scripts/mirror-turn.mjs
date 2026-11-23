#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / UserPromptSubmit) — CONNECTION-NATIVE.
 * Resolves ONLY the connection bound to THIS local conversation — never a
 * machine-global "latest" pointer. Posts mechanically — no LLM tokens.
 *
 * user_prompt → optional local_prompt bubble when attached (literal owner text)
 *             → also seeds phase=trail "Working…" so the live bubble opens immediately
 * stop        → busy/heartbeat + turn marker only (NO assistant text); clears trail state;
 *               a room command whose turn errored or was stopped is told so (turn-failure.mjs);
 *               the turn's end is reported once: not again when the poller already
 *               reported it from Cursor's transcript (transcript-turn-end.mjs);
 *               a usage-limit stop rides the heartbeat, and a turn that ran clears it
 *               (usage-refusal.mjs);
 *               a turn woken only by DevSpec notices and check jobs posts nothing of its
 *               own, except, as a backstop, a write's tell_person mark the model told
 *               nobody about (notice-reply.mjs)
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
import { connectionCredential } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { detectLocalId } from './remote-control-state.mjs'
import { logRemoteControlStory } from './remote-control-story.mjs'
import { clearTrailState, resolveAgentTranscriptPath } from './work-trail.mjs'
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
  appendRequestEvent,
  finishTurnRequests,
  launchForRequest,
  openRequest,
  promptArrival,
  readRequestState,
  requestForLaunch,
  UNSTATED,
} from './requests.mjs'
import { localTurnScope, localTurnToComplete, startLocalTurn } from './local-turn.mjs'
import { clearTurnCommands, completionArguments, readTurnCommands } from './turn-commands.mjs'
import { readTurnActivity, turnActivityPath, turnIsLive } from './turn-liveness.mjs'
import { postTurnFailure } from './turn-failure.mjs'
import { hookTranscriptPath, noteUsageRefusalSent, observeTurnEnd, usageRefusalArgument } from './usage-refusal.mjs'
import {
  claimTurnEnd,
  noteTurnEndCompleted,
  noteTurnEndTold,
  settleTurnEnd,
  turnEndIdentity,
} from './transcript-turn-end.mjs'
import { fitRoomMessage } from './room-message.mjs'
import { clearTurnWakes, postTellPersonAtStop, recordPromptWake } from './notice-reply.mjs'
import { answerCursorAtExit } from './hook-answer.mjs'

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
export function writeTurnMarker(
  connectionId,
  { held = false, remoteTurn = false, dir = CONNECTIONS_DIR } = {},
) {
  if (!connectionId) return
  const existing = readTurnMarker(connectionId, dir)
  const live = markerIsLive(connectionId, existing, { dir })
  const startedAt = live ? existing.startedAt : Date.now()
  const keepRemote = Boolean(remoteTurn || (live && existing?.remoteTurn))
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      turnMarkerPath(connectionId, dir),
      JSON.stringify({
        startedAt,
        ...(held ? { held: true } : {}),
        ...(keepRemote ? { remoteTurn: true } : {}),
      }),
      { mode: 0o600 },
    )
  } catch {
    /* non-fatal — the immediate busy heartbeat below still fires */
  }
}
export function clearTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return
  try {
    fs.rmSync(turnMarkerPath(connectionId, dir), { force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(turnActivityPath(connectionId, dir), { force: true })
  } catch {
    /* ignore */
  }
  // The turn is over, and its end names what it finished (turn-commands.mjs).
  clearTurnCommands(connectionId, { dir })
}
export function readActiveTurnMarker(
  connectionId,
  { maxAgeMs, dir = CONNECTIONS_DIR, now = Date.now() } = {},
) {
  if (!connectionId) return null
  try {
    const marker = readTurnMarker(connectionId, dir)
    if (!marker) return null
    if (typeof maxAgeMs === 'number') {
      return now - marker.startedAt < maxAgeMs ? marker : null
    }
    return markerIsLive(connectionId, marker, { dir, now }) ? marker : null
  } catch {
    return null
  }
}
export function hasActiveTurnMarker(connectionId, maxAgeMs, dir = CONNECTIONS_DIR) {
  if (!connectionId) return false
  try {
    const marker = readTurnMarker(connectionId, dir)
    if (!marker) return false
    if (typeof maxAgeMs === 'number') {
      return Date.now() - marker.startedAt < maxAgeMs
    }
    return markerIsLive(connectionId, marker, { dir })
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
    /"type"\s*:\s*"(?:owner_message|automation_run|automation_dispatch|check_job|question_answer|question_dismissal|system_notice)"/.test(
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
    /"type"\s*:\s*"(?:owner_message|automation_run|automation_dispatch|check_job|question_answer|question_dismissal|system_notice)"/.test(
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
  // Whole up to the room's own limit, never a silent cut (item ac7d624b).
  return fitRoomMessage(t, { whereRest: 'The full reply is in the Cursor conversation that wrote it.' })
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

  // The connection's current credential. When its sign-in has ended, the poller (which
  // asks DevSpec continuously) stands the connection down and says so plainly; this
  // hook has nothing to add to that and exits quietly.
  const credential = connectionCredential(state)
  if (!credential.ok) process.exit(0)
  const token = credential.token
  const mcpUrl = credential.mcp_url
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

  // What this prompt brought into the turn: DevSpec notices, or anything else
  // (notice-reply.mjs). Recorded before the harness-injection exit below, because a
  // notice reaches the model as exactly such an injection.
  if (mode === 'user_prompt' && connectionId) {
    try {
      recordPromptWake(connectionId, {
        fromAPerson,
        text,
        midTurn: promptTurnId(raw) !== null,
        dir: CONNECTIONS_DIR,
      })
    } catch {
      /* an unrecorded wake only means the model passes the notice ids itself */
    }
  }

  // Consume any explicit-reply marker so it cannot bleed into a later turn.
  // Agent answers are skill-posted (ADR b98a39a9); Stop no longer mirrors full
  // assistant text as a primary path — dual writers caused wrong-voice dupes
  // and silent misses when bonding failed. Whether the model posted itself is kept
  // for the one Stop post that remains (notice-reply.mjs, postTellPersonAtStop).
  const hadExplicitReply = mode === 'stop' ? consumeExplicitReplyMarker(connectionId) : false

  // Skip turn marker, work trail seed, local prompt mirroring, and busy assertion
  // when user_prompt has no genuine user text or is harness injection (prevents transient dot flicker).
  if (mode === 'user_prompt' && skipMirror) {
    process.exit(0)
  }

  // The turn end this stop claims (below), and whether its report failed or was cut
  // short: a claim whose report did not reach DevSpec is given back at the end.
  let turnEndClaim = null
  let turnEndFailed = false
  let turnEndDone = false
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
      // Whole up to the room's own limit; past it, visibly marked (item ac7d624b).
      const cleaned = fitRoomMessage(String(text).trim(), {
        whereRest: 'The full prompt is in the Cursor conversation it was typed into.',
      })
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

    // Which turn end this is. When Cursor runs no stop hook, the poller reports a turn's
    // end from Cursor's transcript instead (transcript-turn-end.mjs). Whichever of the
    // two claims a turn end reports it. When the poller holds its report (reporting now,
    // or reported), this hook reports nothing and leaves the turn's marker to the poller;
    // the rest of this stop's work still runs. This hook knows the turn it ends, so it
    // reports in full a turn end the poller could only notice: one noticed already is
    // taken over (the upgrade), and one whose notice is being posted now is answered and
    // closed alongside, the notice left to the poller. When this hook holds the claim,
    // the marker is cleared only once every step has reached DevSpec; otherwise the claim
    // is given back and the marker kept, so the poller reports what is left.
    if (mode === 'stop' && connectionId) {
      const identity = turnEndIdentity(hookTranscriptPath(raw) ?? resolveAgentTranscriptPath(localId))
      if (identity) {
        const trackedFrom = readTurnMarker(connectionId)?.startedAt ?? null
        turnEndClaim = {
          identity,
          trackedFrom,
          ...claimTurnEnd(connectionId, identity, {
            by: 'stop',
            goal: 'report',
            after: trackedFrom,
            dir: CONNECTIONS_DIR,
          }),
        }
      }
    }
    const turnEndReported = turnEndClaim?.outcome === 'reported' || turnEndClaim?.outcome === 'reporting'
    const turnEndClaimedHere = turnEndClaim?.outcome === 'claimed'
    // The poller is posting this turn end's notice now: it keeps the claim and the marker.
    const turnEndNoticing = turnEndClaim?.outcome === 'noticing'

    // A turn that errored or was stopped never answered its room command: say so in
    // the room before the turn ends (item 9a850303, turn-failure.mjs). It marks the
    // command answered, so the request bookkeeping below closes it. A turn the room saw
    // working (its marker) that carries no unanswered command is told as a plain room
    // message instead (item 45eb0708), unless the poller's notice told it already or is
    // telling it now.
    if (mode === 'stop' && connectionId && sessionId && !turnEndReported && !turnEndClaim?.told) {
      try {
        await postTurnFailure({
          raw,
          connectionId,
          sessionId,
          dir: CONNECTIONS_DIR,
          agentName,
          notice: Boolean(readTurnMarker(connectionId)) && !turnEndClaim?.noticed && !turnEndNoticing,
          post: (args) =>
            mcpToolsCall({ mcpUrl, token, name: 'post_session_message', arguments: args, timeoutMs: 15_000 }),
        })
        if (turnEndClaimedHere) noteTurnEndTold(connectionId, turnEndClaim.identity, { dir: CONNECTIONS_DIR })
      } catch {
        /* non-fatal: the turn still ends below */
        turnEndFailed = true
      }
    }

    // A turn woken only by DevSpec notices and check jobs puts nothing into the room
    // on the plugin's word: when a notice is answered there is DevSpec's rule, and the
    // model posts that reply itself (item 140a7f68). A write whose result carried
    // tell_person is the model's to tell its person about (its tell-person command); as
    // a backstop only, when it told nobody, its final message goes to the room as the
    // agent's own message through the speech lane that needs no open turn, and one that
    // cannot be posted is logged and left for the agent's next turn (notice-reply.mjs).
    // Nothing depends on this running. Then what woke the turn is forgotten.
    if (mode === 'stop' && connectionId) {
      try {
        await postTellPersonAtStop({
          raw,
          connectionId,
          sessionId,
          connectionState: state,
          connectionCapability,
          agentName,
          told: hadExplicitReply,
          dir: CONNECTIONS_DIR,
          prepare: prepareAgentMirrorText,
          post: (args, { connectionCapability: capability }) =>
            mcpToolsCall({
              mcpUrl,
              token,
              connectionCapability: capability,
              name: 'post_session_message',
              arguments: args,
              timeoutMs: 15_000,
            }),
        })
      } catch {
        /* a refused post is logged and kept inside; this only guards the turn's end */
      }
      clearTurnWakes(connectionId, { dir: CONNECTIONS_DIR })
    }

    // Turn lifecycle → "working" authority. user_prompt starts a turn (busy:true +
    // marker so the poller re-asserts); stop ends it (busy:false + clear marker).
    // Marker is keyed by connection_id (the poller reads it by connection_id).
    const turnActive = mode === 'user_prompt'
    let stopDecisionAction = null
    // The room commands that started this turn, read before its end removes the record.
    const turnCommands = turnActive ? [] : readTurnCommands(connectionId, { dir: CONNECTIONS_DIR })
    // A turn end this hook holds clears the marker once its report lands (below); one
    // the poller holds, or is noticing, is the poller's to end.
    if (turnActive) writeTurnMarker(connectionId)
    else if (!turnEndClaimedHere && !turnEndReported && !turnEndNoticing) clearTurnMarker(connectionId)

    // Busy heartbeat — one connection-native path (attached or sessionless). The
    // server broadcasts agent_status for the attached session, so no session-keyed
    // heartbeat is needed.
    if (connectionId) {
      // How Cursor ended this turn: a usage-limit stop is reported on this heartbeat and
      // every poll after it until it lifts, and a turn that ran clears an earlier one
      // (usage-refusal.mjs). The poller reads the same turn end too, so a stop hook
      // Cursor skips loses nothing but this heartbeat's head start.
      if (mode === 'stop') {
        observeTurnEnd(connectionId, hookTranscriptPath(raw) ?? resolveAgentTranscriptPath(localId), {
          dir: CONNECTIONS_DIR,
        })
      }
      const usageRefusal = usageRefusalArgument(connectionId, { dir: CONNECTIONS_DIR })
      await mcpToolsCall({
        mcpUrl,
        token,
        name: 'heartbeat_connection',
        arguments: {
          connection_id: connectionId,
          agent_name: agentName,
          status: 'live',
          busy: turnActive,
          ...usageRefusal,
        },
        timeoutMs: 15_000,
      })
      noteUsageRefusalSent(connectionId, usageRefusal, { dir: CONNECTIONS_DIR })
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
        if (decision.action === 'complete') {
          try {
            await mcpToolsCall({
              mcpUrl,
              token,
              connectionCapability,
              name: 'report_complete',
              arguments: {
                connection_id: connectionId,
                attempt_id: decision.continuation.attempt_id,
                reason: 'turn_end',
                ...continuationIdentity(decision.continuation),
              },
              timeoutMs: 15_000,
            })
            clearInteractionContinuation(connectionId)
            logRemoteControlStory({
              phase: 'complete_turn',
              outcome: 'completed',
              connectionId,
              agent: agentName || AGENT_NAME,
              tool: 'mirror-turn.stop',
              reason: 'exact_interaction_turn_end',
            })
          } catch {
            /* non-fatal — the poller's marker-driven backstop still runs */
            turnEndFailed = true
          }
        } else if (decision.action !== 'hold' && !turnEndReported && !turnEndClaim?.completed) {
          // Each thing the turn finishes, by name (turn-commands.mjs): the room
          // commands that started it and the terminal turn the owner typed, or, when it
          // had neither, only an activity no command started. So a command handed over
          // as the turn ended is never finished by it.
          const calls = completionArguments({
            connectionId,
            commands: turnCommands,
            localAttemptId: localTurnToComplete(state.local_turn, sessionId),
            reason: 'turn_end',
          })
          let completed = true
          for (const args of calls) {
            try {
              await mcpToolsCall({ mcpUrl, token, name: 'report_complete', arguments: args, timeoutMs: 15_000 })
            } catch {
              /* non-fatal — the poller's marker-driven backstop still runs */
              completed = false
            }
          }
          if (completed) {
            if (turnEndClaimedHere) noteTurnEndCompleted(connectionId, turnEndClaim.identity, { dir: CONNECTIONS_DIR })
            logRemoteControlStory({
              phase: 'complete_turn',
              outcome: 'completed',
              connectionId,
              agent: agentName || AGENT_NAME,
              tool: 'mirror-turn.stop',
              reason: 'turn_end',
            })
          } else {
            turnEndFailed = true
          }
        }
        if (decision.action !== 'hold') {
          // The turn is over whether or not its completion landed: never carry the
          // typed turn into the next one.
          if (state.local_turn) patchOwnState(connectionId, { local_turn: null })
        }
      }
    }

    // The turn end's request bookkeeping, done by whichever of this hook and the poller
    // reports the turn end (requests.mjs finishTurnRequests): not again here when the
    // poller already did it.
    if (mode === 'stop' && connectionId && connectionCapability && !turnEndReported) {
      const { failed } = await finishTurnRequests({
        connectionId,
        call: (args) => callRequest(args, 3_000),
        dir: CONNECTIONS_DIR,
        backgroundTasks: parseBackgroundTasks(raw),
        sessionCrons: parseSessionCrons(raw),
        holdCurrent: stopDecisionAction === 'hold',
      })
      if (failed.length > 0) turnEndFailed = true
    }
    turnEndDone = true
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }
  if (turnEndClaim?.outcome === 'claimed') {
    const reported = !turnEndFailed && turnEndDone
    settleTurnEnd(connectionId, turnEndClaim.identity, { reported, dir: CONNECTIONS_DIR })
    // Only the marker of the turn this hook ended: after a notice the poller has cleared
    // it, and a command handed over since has a marker of its own.
    if (reported && (readTurnMarker(connectionId)?.startedAt ?? null) === turnEndClaim.trackedFrom) {
      clearTurnMarker(connectionId)
    }
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  answerCursorAtExit()
  main()
}
