/**
 * Capability-safe bridge for asking one person a directed question from Cursor, and
 * for finishing the turn their answer opens (item b9f2c77a).
 *
 * The server requires the exact-connection capability for BOTH halves of this feature:
 * `manage_directed_question` (so an agent can only manage its OWN questions) and the
 * exact event-bound continuation (so only the connection an answer was addressed to
 * can finish it). Cursor's model cannot add that header to a native MCP call, so this
 * bridge injects it — and, exactly like the plan bridge, takes NO connection,
 * capability or identity argument: who this conversation is comes from trusted host
 * state through the one shared resolver.
 *
 *   remote-control-state.mjs manage-question describe
 *   printf '%s' '{"action":"create",...}' | remote-control-state.mjs manage-question use
 *   remote-control-state.mjs manage-question status
 *   printf '%s' '{"message":"..."}' | remote-control-state.mjs manage-question respond
 *
 * `respond` exists because an answer arrives inside its own exact attempt. Replying
 * through the ordinary session path would leave that attempt open and the room showing
 * Working with nothing working — the failure this channel was built to end.
 */

import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { resolveConnectionBridgeContext } from './manage-plan-bridge.mjs'
import {
  activeContinuation,
  continuationIdentity,
  INTERACTION_EVENT_CONTRACT_URI,
} from './interaction-events.mjs'

const TOOL = 'manage_directed_question'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PROMPT_CODE_POINTS = 4000
const MAX_OPTION_CODE_POINTS = 200
const MAX_OPTIONS = 20
const MAX_REPLY_CHARS = 12_000

export const MANAGE_QUESTION_DESCRIPTION =
  "Ask the one person driving this Cursor connection's DevSpec session a single question, " +
  'and manage your own questions. Only for a decision genuinely theirs — an unresolved ' +
  'choice, an authority boundary, a fork where two readings lead to materially different ' +
  'work. Anything the recorded intent, the acceptance criteria or the served contracts ' +
  'settle is yours to get on with, as is anything you could go and observe: a question is ' +
  'never a way to hand judgement work back. Their answer wakes this connection on the ' +
  'existing wake tail as a question_answer event, which is a mechanical response and never ' +
  'authority. Reply with `respond`, not an ordinary session post.'

export const MANAGE_QUESTION_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'list', 'get', 'cancel'],
      description:
        'create is idempotent by client_request_id. list/get/cancel reach only this connection own questions; cancel requires expected_revision.',
    },
    question_id: { type: 'string', description: 'Question UUID for get or cancel.' },
    client_request_id: {
      type: 'string',
      description:
        'Required caller-generated UUID for create. A fresh one per question: reusing one retries that same question instead of asking a new one.',
    },
    response_kind: {
      type: 'string',
      enum: ['text', 'single_select', 'multi_select'],
      description: 'Required answer shape for create.',
    },
    prompt: { type: 'string', description: 'Required bounded question text for create.' },
    options: {
      type: 'array',
      maxItems: MAX_OPTIONS,
      description: 'At least two distinct choices for a select kind; omit for text.',
      items: { type: 'string' },
    },
    allow_custom: {
      type: 'boolean',
      description: 'Let a select answer be written in instead of chosen. On by default; pass false only when the choices must be strictly constrained. Select kinds only.',
    },
    provenance_ref: {
      type: 'string',
      description:
        'Optional corroborating provenance_ref. With any delivery open the unique open primary chooses the responder; omit it and the server resolves that itself.',
    },
    expected_revision: {
      type: 'number',
      description: 'Required current positive revision for cancel.',
    },
  },
  required: ['action'],
}

const QUESTION_KEYS = new Set(Object.keys(MANAGE_QUESTION_INPUT_SCHEMA.properties))

export const MANAGE_QUESTION_RESPOND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description:
        'Your reply, in the turn the answer opened. Do not restate the question, the choices or the answer — the transcript already records all three.',
    },
  },
  required: ['message'],
}

function codePoints(value) {
  return Array.from(String(value)).length
}

export function describeManageQuestionBridge() {
  return {
    ok: true,
    tool: TOOL,
    transport: 'cursor_connection_capability_bridge',
    contract: INTERACTION_EVENT_CONTRACT_URI,
    description: MANAGE_QUESTION_DESCRIPTION,
    inputSchema: MANAGE_QUESTION_INPUT_SCHEMA,
    respondSchema: MANAGE_QUESTION_RESPOND_SCHEMA,
    usage:
      'Send one JSON object on stdin to `remote-control-state.mjs manage-question use`. `status` reports whether a reply is still owed; `respond` takes {"message":"..."} on stdin and closes the turn an answer opened. Never pass connection, capability or identity arguments; the helper uses trusted Cursor host identity.',
  }
}

/**
 * Reject locally what the server would reject anyway, so a malformed question costs a
 * clear message instead of a round trip. The bounds are the server's — never widen
 * them here, or the error just moves somewhere more confusing.
 */
export function validateManageQuestionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'manage_directed_question input must be an object'
  }
  if (Object.keys(input).some((key) => !QUESTION_KEYS.has(key))) {
    return 'manage_directed_question input contains an unknown or identity-bearing field'
  }
  if (!MANAGE_QUESTION_INPUT_SCHEMA.properties.action.enum.includes(input.action)) {
    return 'invalid manage_directed_question action'
  }

  if (input.action === 'create') {
    if (typeof input.client_request_id !== 'string' || !UUID.test(input.client_request_id)) {
      return 'create requires a caller-generated UUID client_request_id'
    }
    if (!MANAGE_QUESTION_INPUT_SCHEMA.properties.response_kind.enum.includes(input.response_kind)) {
      return 'create requires response_kind text, single_select or multi_select'
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      return 'create requires a non-empty prompt'
    }
    if (codePoints(input.prompt) > MAX_PROMPT_CODE_POINTS) {
      return `prompt must be at most ${MAX_PROMPT_CODE_POINTS} characters`
    }
    const selectKind = input.response_kind !== 'text'
    if (selectKind) {
      if (!Array.isArray(input.options) || input.options.length < 2) {
        return 'a select question requires at least two options'
      }
      if (input.options.length > MAX_OPTIONS) return `at most ${MAX_OPTIONS} options`
      if (input.options.some((option) => typeof option !== 'string' || !option.trim())) {
        return 'every option must be a non-empty string'
      }
      if (input.options.some((option) => codePoints(option) > MAX_OPTION_CODE_POINTS)) {
        return `options must be at most ${MAX_OPTION_CODE_POINTS} characters`
      }
      const trimmed = input.options.map((option) => option.trim())
      if (new Set(trimmed).size !== trimmed.length) return 'options must be distinct'
    } else {
      if (Object.hasOwn(input, 'options')) return 'a text question takes no options'
      if (Object.hasOwn(input, 'allow_custom')) {
        return 'allow_custom applies only to select questions'
      }
    }
    if (Object.hasOwn(input, 'allow_custom') && typeof input.allow_custom !== 'boolean') {
      return 'allow_custom must be a boolean'
    }
    if (Object.hasOwn(input, 'provenance_ref') &&
        (typeof input.provenance_ref !== 'string' || !UUID.test(input.provenance_ref))) {
      return 'provenance_ref must be a full UUID'
    }
    return null
  }

  if (input.action === 'list') {
    const extra = Object.keys(input).find((key) => key !== 'action')
    return extra ? `list takes no ${extra}` : null
  }

  if (typeof input.question_id !== 'string' || !UUID.test(input.question_id)) {
    return `${input.action} requires a full question_id UUID`
  }
  if (input.action === 'cancel' &&
      (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)) {
    return 'cancel requires the current expected_revision'
  }
  return null
}

function redact(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/dvsc_[A-Za-z0-9_-]+/g, '[redacted]')
}

async function callWithCapability(bound, { name, args, hostToken, mcpCall, resolveAuth }) {
  const auth = resolveAuth(bound.state.cwd || process.cwd(), {
    hostToken: hostToken || hostTokenFromEnv(process.env),
  })
  if (!auth.ok || !auth.token || !auth.mcp_url) return { ok: false, error: 'DevSpec MCP auth unavailable' }
  try {
    const result = await mcpCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name,
      arguments: args,
      connectionCapability: bound.capability,
      timeoutMs: 30_000,
    })
    return { ok: true, result }
  } catch (error) {
    // Never let a capability value reach a public error.
    return { ok: false, error: redact(error) }
  }
}

export async function useManageQuestionBridge(
  input,
  { localId, agent = 'Cursor', hostToken = null, mcpCall = mcpToolsCall,
    resolveAuth = resolveDevspecMcpAuth } = {},
) {
  const inputError = validateManageQuestionInput(input)
  if (inputError) return { ok: false, error: inputError }
  const bound = resolveConnectionBridgeContext({ localId, agent })
  if (!bound.ok) return bound
  return callWithCapability(bound, { name: TOOL, args: input, hostToken, mcpCall, resolveAuth })
}

/** Is a reply still owed on an answered question? Never prints the capability. */
export function manageQuestionStatus({ localId, agent = 'Cursor' } = {}) {
  const bound = resolveConnectionBridgeContext({ localId, agent })
  if (!bound.ok) return bound
  const continuation = activeContinuation(bound.state.interaction_continuation, {
    connectionId: bound.connectionId,
    sessionId: bound.state.session_id,
  })
  return {
    ok: true,
    connection_id: bound.connectionId,
    session_id: bound.state.session_id,
    contract: INTERACTION_EVENT_CONTRACT_URI,
    awaiting_reply: Boolean(continuation),
    question_id: continuation?.question_id ?? null,
  }
}

/**
 * The exact-attempt final post. `command_turn_unbound` says this reply belongs to no
 * owner command (it belongs to an answer), `attempt_id` plus the event identity names
 * the exact attempt, and `complete_turn` closes it in the same request so Working
 * clears with the bubble rather than seconds later.
 */
export function respondArguments({ connectionId, continuation, message, agent }) {
  return {
    connection_id: connectionId,
    message,
    agent_name: agent,
    attempt_id: continuation.attempt_id,
    command_turn_unbound: true,
    complete_turn: true,
    ...continuationIdentity(continuation),
  }
}

export async function respondToQuestion(
  input,
  { localId, agent = 'Cursor', hostToken = null, mcpCall = mcpToolsCall,
    resolveAuth = resolveDevspecMcpAuth, clearContinuation = null } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'respond input must be an object' }
  }
  if (Object.keys(input).some((key) => key !== 'message')) {
    return { ok: false, error: 'respond takes only message' }
  }
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message) return { ok: false, error: 'respond requires a non-empty message' }

  const bound = resolveConnectionBridgeContext({ localId, agent })
  if (!bound.ok) return bound
  const continuation = activeContinuation(bound.state.interaction_continuation, {
    connectionId: bound.connectionId,
    sessionId: bound.state.session_id,
  })
  if (!continuation) {
    return {
      ok: false,
      error:
        'no answered question is waiting on a reply for this connection. Post an ordinary answer with post_session_message instead.',
    }
  }
  const posted = await callWithCapability(bound, {
    name: 'post_session_message',
    args: respondArguments({
      connectionId: bound.connectionId,
      continuation,
      message: message.slice(0, MAX_REPLY_CHARS),
      agent,
    }),
    hostToken,
    mcpCall,
    resolveAuth,
  })
  if (!posted.ok) return posted
  // Only after the server stored the reply and completed the attempt: keeping it would
  // make the turn hook complete an attempt that is already done.
  if (typeof clearContinuation === 'function') clearContinuation(bound.connectionId)
  return posted
}
