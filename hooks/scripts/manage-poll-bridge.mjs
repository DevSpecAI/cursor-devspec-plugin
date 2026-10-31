import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { resolveConnectionBridgeContext } from './manage-plan-bridge.mjs'
import { SESSION_POLL_MAX_OPTIONS } from './remote-ingress-v1.mjs'

const TOOL = 'manage_poll'
const READ_ACTIONS = new Set(['list', 'get'])
const EXISTING_POLL_ACTIONS = new Set(['update', 'end', 'retract', 'supersede'])
const CLIENT_REQUEST_ID_ACTIONS = new Set(['create', 'supersede'])
// The server's own poll bounds (SESSION_POLL_MAX_OPTIONS in its poll projection):
// checked here so a bad poll is refused with its reason before the capability call.
const MIN_OPTIONS = 2
const MAX_OPTIONS = SESSION_POLL_MAX_OPTIONS

export const MANAGE_POLL_DESCRIPTION =
  "Manage the capability-authenticated Cursor connection's session polls. A poll is a non-blocking room ballot — never a blocking agent driver — so creating, updating, or ending a poll never opens, holds, or completes an activity turn or claims a reply channel. Existing-poll mutations require poll_id and expected_revision; create and supersede require a caller-generated client_request_id. There is no vote action: voting is for people in the room, and recommendation_index is advice only."

export const MANAGE_POLL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'list', 'get', 'update', 'end', 'retract', 'supersede'],
      description:
        'list/get are reads. update/end/retract/supersede require poll_id and expected_revision; create and supersede require client_request_id.',
    },
    poll_id: {
      type: 'string',
      description: 'Poll UUID for get, update, end, retract, or supersede.',
    },
    expected_revision: {
      type: 'number',
      description: 'Required positive revision for every existing-poll mutation.',
    },
    client_request_id: {
      type: 'string',
      description: 'Required caller-generated idempotency key for create and supersede.',
    },
    question: {
      type: 'string',
      description: 'Poll question text (required for create).',
    },
    options: {
      type: 'array',
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: 'Poll option labels (2–30 non-empty strings; required for create).',
      items: { type: 'string' },
    },
    recommendation_index: {
      type: 'number',
      description: 'Optional 0-based index of the option you recommend (advice only, not a vote).',
    },
    multi_select: {
      type: 'boolean',
      description: 'Whether voters may select more than one option.',
    },
    allow_write_in: {
      type: 'boolean',
      description: 'Whether voters may submit a write-in option.',
    },
    series_id: {
      type: 'string',
      description: 'Optional series identifier (requires series_label).',
    },
    series_label: {
      type: 'string',
      description: 'Human-readable label for series_id.',
    },
    reason: {
      type: 'string',
      description: 'Required explanation for retract.',
    },
    status: {
      type: 'string',
      enum: ['all', 'active', 'ended', 'retracted', 'superseded'],
      description: 'Optional status filter for list.',
    },
  },
  required: ['action'],
}

const MANAGE_POLL_KEYS = new Set(Object.keys(MANAGE_POLL_INPUT_SCHEMA.properties))
const LIST_STATUSES = new Set(MANAGE_POLL_INPUT_SCHEMA.properties.status.enum)

export function describeManagePollBridge() {
  return {
    ok: true,
    tool: TOOL,
    transport: 'cursor_connection_capability_bridge',
    description: MANAGE_POLL_DESCRIPTION,
    inputSchema: MANAGE_POLL_INPUT_SCHEMA,
    usage:
      'Send one JSON object on stdin to `remote-control-state.mjs manage-poll use`. Do not pass connection or capability arguments; the helper uses Cursor host identity, or exactly one live attached minted host bond in the current workspace when manual Cursor supplies no conversation id.',
  }
}

export function validateManagePollInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'manage_poll input must be an object'
  }
  if (Object.keys(input).some((key) => !MANAGE_POLL_KEYS.has(key))) {
    return 'manage_poll input contains an unknown or identity-bearing field'
  }
  if (!MANAGE_POLL_INPUT_SCHEMA.properties.action.enum.includes(input.action)) {
    return 'invalid manage_poll action'
  }

  if (EXISTING_POLL_ACTIONS.has(input.action)) {
    if (typeof input.poll_id !== 'string' || !input.poll_id.trim()) {
      return `${input.action} requires poll_id`
    }
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) {
      return 'existing-poll mutations require expected_revision'
    }
  } else if (Object.hasOwn(input, 'expected_revision') && !READ_ACTIONS.has(input.action)) {
    return 'expected_revision applies only to an existing poll'
  }

  if (
    CLIENT_REQUEST_ID_ACTIONS.has(input.action) &&
    (typeof input.client_request_id !== 'string' || !input.client_request_id.trim())
  ) {
    return `${input.action} requires a caller-generated client_request_id`
  }
  if (input.action === 'retract' && (typeof input.reason !== 'string' || !input.reason.trim())) {
    return 'retract requires a reason'
  }

  if (Object.hasOwn(input, 'options')) {
    if (!Array.isArray(input.options)) return 'options must be an array'
    if (input.options.some((option) => typeof option !== 'string' || !option.trim())) {
      return 'every option must be a non-empty string'
    }
    if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
      return `options must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} entries`
    }
  }
  if (input.action === 'create' && !Array.isArray(input.options)) {
    return 'create requires options'
  }
  if (input.action === 'create' && (typeof input.question !== 'string' || !input.question.trim())) {
    return 'create requires a question'
  }

  if (Object.hasOwn(input, 'recommendation_index')) {
    const index = input.recommendation_index
    if (!Number.isSafeInteger(index) || index < 0) {
      return 'recommendation_index must be a 0-based option index'
    }
    if (Array.isArray(input.options) && index >= input.options.length) {
      return 'recommendation_index is outside the options'
    }
  }

  if (
    Object.hasOwn(input, 'series_id') &&
    (typeof input.series_label !== 'string' || !input.series_label.trim())
  ) {
    return 'series_id requires series_label'
  }
  if (Object.hasOwn(input, 'status') && !LIST_STATUSES.has(input.status)) {
    return 'unknown status filter'
  }
  for (const key of ['multi_select', 'allow_write_in']) {
    if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') {
      return `${key} must be a boolean`
    }
  }
  return null
}

export async function useManagePollBridge(
  input,
  { localId, agent = 'Cursor', root, cwd, hostToken = null, mcpCall = mcpToolsCall,
    resolveAuth = resolveDevspecMcpAuth } = {},
) {
  const inputError = validateManagePollInput(input)
  if (inputError) return { ok: false, error: inputError }
  const bound = resolveConnectionBridgeContext(
    { localId, agent },
    { ...(root ? { root } : {}), ...(cwd ? { cwd } : {}) },
  )
  if (!bound.ok) return bound
  const auth = resolveAuth(bound.state.cwd || process.cwd(), {
    hostToken: hostToken || hostTokenFromEnv(process.env),
  })
  if (!auth.ok || !auth.token || !auth.mcp_url) return { ok: false, error: 'DevSpec MCP auth unavailable' }
  try {
    const result = await mcpCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: TOOL,
      arguments: input,
      connectionCapability: bound.capability,
      timeoutMs: 30_000,
    })
    return { ok: true, result }
  } catch (error) {
    // Never include request headers or capability values in the public error.
    return {
      ok: false,
      error: error instanceof Error
        ? error.message.replace(/dvsc_[A-Za-z0-9_-]+/g, '[redacted]')
        : 'manage_poll failed',
    }
  }
}
