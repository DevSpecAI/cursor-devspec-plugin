import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'

export const CONNECTION_CAPABILITY_VERSION = 1
export const MANAGE_PLAN_DESCRIPTION =
  "Manage the capability-authenticated Cursor connection's shared session plan. `devspec://product/implementation-contract` → `work_entry_contract` decides WHEN a plan is warranted; this bridge provides mechanics only. Existing-plan mutations require expected_revision. Omit plan_id for this connection's own active plan; explicit plan_id means intentional same-owner, same-session cross-plan targeting. Prefer advance for an atomic current-complete/next-start transition. Adoption is only for an orphaned same-owner plan."

export const MANAGE_PLAN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [
        'create', 'list', 'get', 'update', 'start_step', 'complete_step', 'skip_step',
        'fail_step', 'advance', 'complete', 'abandon', 'adopt',
      ],
      description:
        'list/get are reads. Every existing-plan mutation requires expected_revision and defaults to this connection own active plan when plan_id is omitted.',
    },
    plan_id: {
      type: 'string',
      description:
        'Explicit plan UUID for intentional same-owner, same-session cross-plan targeting. Omit for default-own get or mutation.',
    },
    expected_revision: {
      type: 'number',
      description: 'Required positive revision for every existing-plan mutation.',
    },
    title: { type: 'string', description: 'Short title for create.' },
    steps: {
      type: 'array',
      maxItems: 50,
      description:
        'Ordered milestones for create/update, or an optional authoritative amendment during advance.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Existing step UUID when retaining/amending a step.' },
          title: { type: 'string', description: 'Milestone title.' },
          description: { type: 'string', description: 'Optional bounded milestone detail.' },
        },
        required: ['title'],
      },
    },
    step_id: { type: 'string', description: 'Step UUID for a single-step transition.' },
    current_step_id: {
      type: 'string',
      description: 'Optional current step UUID for advance; defaults to the in-progress step.',
    },
    next_step_id: {
      type: 'string',
      description: 'Optional next pending step UUID for advance; defaults to the next pending milestone.',
    },
    reason: { type: 'string', description: 'Required for fail_step and abandon.' },
    retryable: { type: 'boolean', description: 'Required for fail_step.' },
  },
  required: ['action'],
}

const MANAGE_PLAN_KEYS = new Set(Object.keys(MANAGE_PLAN_INPUT_SCHEMA.properties))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function safeSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value) ? value : null
}
function agentSlug(agent) {
  return String(agent || 'Cursor').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cursor'
}
function defaultRoot() {
  return path.join(os.homedir(), '.devspec', 'remote-control')
}
function capabilityPath(connectionId, root = defaultRoot()) {
  if (!UUID.test(String(connectionId || ''))) return null
  return path.join(root, 'connections', `${connectionId}.capability.json`)
}
function bondPath(agent, localId, root = defaultRoot()) {
  const safe = safeSegment(localId)
  return safe ? path.join(root, 'local', agentSlug(agent), `${safe}.json`) : null
}
function statePath(connectionId, root = defaultRoot()) {
  if (!UUID.test(String(connectionId || ''))) return null
  return path.join(root, 'connections', `${connectionId}.json`)
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** Trusted register helper only: persist the raw value without returning it. */
export function persistConnectionCapability(
  { connectionId, localId, capability, version = CONNECTION_CAPABILITY_VERSION },
  { root = defaultRoot(), io = fs } = {},
) {
  const file = capabilityPath(connectionId, root)
  if (!file || !safeSegment(localId) || version !== CONNECTION_CAPABILITY_VERSION ||
      typeof capability !== 'string' || !capability.startsWith('dvsc_')) {
    return { ok: false, error: 'invalid connection capability envelope' }
  }
  const directory = path.dirname(file)
  io.mkdirSync(directory, { recursive: true, mode: 0o700 })
  // One conversation has one current capability. Rotation removes stale sibling files
  // before installing the newly returned exact-connection value.
  for (const name of io.readdirSync(directory)) {
    if (!name.endsWith('.capability.json')) continue
    const candidate = path.join(directory, name)
    let record = null
    try { record = JSON.parse(io.readFileSync(candidate, 'utf8')) } catch { /* ignore */ }
    if (record?.local_id === localId && candidate !== file) {
      try { io.rmSync(candidate, { force: true }) } catch { /* fail closed below on use */ }
    }
  }
  io.writeFileSync(file, JSON.stringify({
    version,
    connection_id: connectionId,
    local_id: localId,
    capability,
    rotated_at: new Date().toISOString(),
  }) + '\n', { mode: 0o600 })
  io.chmodSync(file, 0o600)
  return { ok: true, connection_id: connectionId, version, path: file }
}

export function clearConnectionCapability(connectionId, { root = defaultRoot(), io = fs } = {}) {
  const file = capabilityPath(connectionId, root)
  if (!file) return false
  try { io.rmSync(file, { force: true }); return true } catch { return false }
}

export function describeManagePlanBridge() {
  return {
    ok: true,
    tool: 'manage_plan',
    transport: 'cursor_connection_capability_bridge',
    description: MANAGE_PLAN_DESCRIPTION,
    inputSchema: MANAGE_PLAN_INPUT_SCHEMA,
    usage:
      'Send one JSON object on stdin to `remote-control-state.mjs manage-plan use`. Do not pass connection or capability arguments; the helper uses Cursor host identity, or exactly one live attached minted host bond in the current workspace when manual Cursor supplies no conversation id.',
  }
}

export function validateManagePlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'manage_plan input must be an object'
  if (Object.keys(input).some((key) => !MANAGE_PLAN_KEYS.has(key))) {
    return 'manage_plan input contains an unknown or identity-bearing field'
  }
  if (!MANAGE_PLAN_INPUT_SCHEMA.properties.action.enum.includes(input.action)) return 'invalid manage_plan action'
  if (input.expected_revision !== undefined &&
      (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)) {
    return 'expected_revision must be a positive integer'
  }
  if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.length > 50)) {
    return 'steps must be an array of at most 50 milestones'
  }
  return null
}

function resolveExactBond(localId, agent, root) {
  const bondFile = bondPath(agent, localId, root)
  const bond = bondFile ? readJson(bondFile) : null
  const connectionId = bond?.connection_id
  const stateFile = statePath(connectionId, root)
  const state = stateFile ? readJson(stateFile) : null
  const capFile = capabilityPath(connectionId, root)
  const cap = capFile ? readJson(capFile) : null
  if (!UUID.test(String(connectionId || '')) || !state || state.enabled === false ||
      state.connection_id !== connectionId || state.agent_name !== agent || state.local_id !== localId ||
      bond.local_id !== localId || bond.agent_name !== agent || bond.status !== 'live') {
    return { ok: false, error: 'current Cursor conversation has no live exact connection bond' }
  }
  if (!UUID.test(String(state.session_id || ''))) {
    return { ok: false, error: 'current Cursor connection is not unambiguously attached to a session' }
  }
  if (!cap || cap.version !== CONNECTION_CAPABILITY_VERSION || cap.connection_id !== connectionId ||
      cap.local_id !== localId || typeof cap.capability !== 'string' || !cap.capability.startsWith('dvsc_')) {
    return { ok: false, error: 'current connection has no valid plan capability; reconnect with the updated plugin' }
  }
  return { ok: true, connectionId, state, capability: cap.capability, localId }
}

/**
 * Resolve identity only from trusted host state. Native Cursor conversations use the
 * host-provided id. Manual Cursor chats have no CURSOR_CONVERSATION_ID, so accept the
 * host's minted local-bond index only when exactly one live, attached, capability-bound
 * Cursor bond exists. Never choose a newest/legacy pointer or model-supplied id.
 */
export function resolveManagePlanBridgeContext(
  { localId, agent = 'Cursor' },
  { root = defaultRoot(), cwd = process.cwd() } = {},
) {
  if (safeSegment(localId)) {
    const exact = resolveExactBond(localId, agent, root)
    return exact.ok ? { ...exact, source: 'host_conversation_id' } : exact
  }

  const directory = path.join(root, 'local', agentSlug(agent))
  const candidates = []
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue
      const indexedLocalId = name.slice(0, -'.json'.length)
      if (!safeSegment(indexedLocalId)) continue
      const exact = resolveExactBond(indexedLocalId, agent, root)
      if (exact.ok && typeof exact.state.cwd === 'string' && exact.state.cwd &&
          path.resolve(exact.state.cwd) === path.resolve(cwd)) candidates.push(exact)
    }
  } catch {
    /* missing/unreadable host index fails closed below */
  }
  if (candidates.length === 1) {
    return { ...candidates[0], source: 'unambiguous_host_bond_index' }
  }
  return {
    ok: false,
    error: candidates.length > 1
      ? 'manual Cursor plan bond is ambiguous in this workspace; refusing to select among sibling connections'
      : 'Cursor conversation id is unavailable and no unambiguous live attached plan bond exists in this workspace',
  }
}

export async function useManagePlanBridge(
  input,
  { localId, agent = 'Cursor', root = defaultRoot(), hostToken = null, mcpCall = mcpToolsCall,
    resolveAuth = resolveDevspecMcpAuth } = {},
) {
  const inputError = validateManagePlanInput(input)
  if (inputError) return { ok: false, error: inputError }
  const bound = resolveManagePlanBridgeContext({ localId, agent }, { root })
  if (!bound.ok) return bound
  const auth = resolveAuth(bound.state.cwd || process.cwd(), {
    hostToken: hostToken || hostTokenFromEnv(process.env),
  })
  if (!auth.ok || !auth.token || !auth.mcp_url) return { ok: false, error: 'DevSpec MCP auth unavailable' }
  try {
    const result = await mcpCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'manage_plan',
      arguments: input,
      connectionCapability: bound.capability,
      timeoutMs: 30_000,
    })
    return { ok: true, result }
  } catch (error) {
    // Never include request headers or capability values in the public error.
    return { ok: false, error: error instanceof Error ? error.message.replace(/dvsc_[A-Za-z0-9_-]+/g, '[redacted]') : 'manage_plan failed' }
  }
}

export function buildActiveSessionPlanGuidance(projection, connectionId) {
  if (!projection?.plans?.length) return ''
  const lines = [
    'Active session plans are advisory all-room read awareness, never mutation authority.',
    'First continue or explicitly close your own active plan before creating another. Use atomic advance at meaningful phase boundaries.',
    'Every existing-plan mutation uses the displayed expected_revision. Omit plan_id for default-own work; explicit plan_id is required for intentional cross-plan targeting or adoption.',
    'Only same-owner plans in this session are mutable; another owner’s plan is read-only. Adopt only an orphaned same-owner plan; the server remains authoritative.',
  ]
  for (const plan of projection.plans) {
    const own = plan.steward?.connection_id === connectionId
    lines.push(`${own ? 'OWN' : 'ROOM'} plan_id=${plan.id} expected_revision=${plan.revision} orphaned=${plan.orphaned === true}`)
    if (own) {
      const active = plan.steps.find((step) => step.status === 'in_progress')
      if (active) lines.push(`Resume in-progress step_id=${active.id} before any pending milestone.`)
    }
  }
  return lines.join('\n')
}
