// Pure Cursor-side validator/normalizer for the canonical remote-ingress contract.
// Runtime policy and schema authority: devspec://product/remote-ingress-contract

export const REMOTE_INGRESS_RESOURCE_URI = 'devspec://product/remote-ingress-contract'
export const REMOTE_INGRESS_SCHEMA_VERSION = 1
export const REMOTE_INGRESS_CONTRACT_VERSION = '1.1.0'
export const REMOTE_INGRESS_POLICY_VERSION = '2026-08-19.2'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATETIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/
const WAKE_KINDS = new Set(['conversational_command', 'control', 'advisory_update', 'history_reseed', 'idle'])
const ACTOR_KINDS = new Set(['human', 'agent', 'ai', 'system'])
const RELATIONSHIPS = new Set(['before_window', 'within_window', 'after_command'])
const AUTHORITY_KINDS = new Set(['owner', 'delegated'])
const AUTHORITY_MODES = new Set(['owner', 'project', 'allowlist'])
const OMISSION_REASONS = new Set(['policy_limit', 'model_budget', 'transport_budget', 'filter', 'history_before_window', 'delivery_retry'])
const CONTROL_VERBS = new Set(['abort', 'set_model', 'set_thinking', 'compact', 'reload', 'list_models'])
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function uuid(value) { return typeof value === 'string' && UUID.test(value) }
function text(value) { return typeof value === 'string' && value.length > 0 }
function nullableText(value) { return value === null || text(value) }
function datetime(value) { return typeof value === 'string' && DATETIME.test(value) && Number.isFinite(Date.parse(value)) }
function integer(value, min = 0) { return Number.isInteger(value) && value >= min }
function ordered(rows) { return rows.every((row, i) => i === 0 || rows[i - 1].order.sequence < row.order.sequence) }

function validOrder(value) {
  return exact(value, ['sequence', 'created_at', 'message_id']) && integer(value.sequence, 1) &&
    datetime(value.created_at) && uuid(value.message_id)
}
function sameOrder(a, b) { return a.sequence === b.sequence && a.created_at === b.created_at && a.message_id === b.message_id }
function validAddressee(value) {
  return exact(value, ['connection_id', 'agent_name', 'codename', 'label']) && uuid(value.connection_id) &&
    nullableText(value.agent_name) && nullableText(value.codename) && text(value.label)
}
function validAttachment(value) {
  if (!object(value)) return false
  const base = ['materialization', 'filename', 'mime_type', 'type', 'size_bytes', 'resource_id']
  if (value.materialization === 'metadata') {
    return exact(value, base) && text(value.filename) && text(value.mime_type) && text(value.type) &&
      (value.size_bytes === null || integer(value.size_bytes)) && uuid(value.resource_id)
  }
  if (value.materialization === 'unavailable') {
    return exact(value, [...base, 'reason']) && text(value.filename) && text(value.mime_type) && text(value.type) &&
      (value.size_bytes === null || integer(value.size_bytes)) && value.resource_id === null &&
      new Set(['missing_resource', 'legacy_inline_payload', 'access_denied']).has(value.reason)
  }
  return false
}
function validAuthority(value) {
  if (!exact(value, ['kind', 'mode', 'requested_by_user_id', 'connection_owner_user_id', 'decision_source']) ||
      !AUTHORITY_KINDS.has(value.kind) || !AUTHORITY_MODES.has(value.mode) ||
      !uuid(value.requested_by_user_id) || !uuid(value.connection_owner_user_id) || value.decision_source !== 'server') return false
  const requesterIsOwner = value.requested_by_user_id === value.connection_owner_user_id
  return (value.kind === 'owner') === requesterIsOwner && !(value.mode === 'owner' && value.kind !== 'owner')
}
function validCommand(value) {
  if (!exact(value, ['message_id', 'order', 'content', 'attachments', 'requester', 'authority', 'addressee', 'delivery']) ||
      !uuid(value.message_id) || !validOrder(value.order) || value.message_id !== value.order.message_id ||
      !exact(value.content, ['mode', 'body', 'complete']) || value.content.mode !== 'full' ||
      typeof value.content.body !== 'string' || value.content.complete !== true ||
      !Array.isArray(value.attachments) || !value.attachments.every(validAttachment) ||
      !exact(value.requester, ['user_id', 'display_name']) || !uuid(value.requester.user_id) ||
      !nullableText(value.requester.display_name) || !validAuthority(value.authority) ||
      value.requester.user_id !== value.authority.requested_by_user_id || !validAddressee(value.addressee) ||
      !exact(value.delivery, ['provenance_ref', 'turn_id', 'primary_provenance_ref', 'is_primary']) ||
      !uuid(value.delivery.provenance_ref) || !uuid(value.delivery.turn_id) ||
      !uuid(value.delivery.primary_provenance_ref) || typeof value.delivery.is_primary !== 'boolean') return false
  return true
}
function validActor(value, expectedKind) {
  return exact(value, ['kind', 'user_id', 'display_name', 'agent_tool', 'model']) &&
    ACTOR_KINDS.has(value.kind) && value.kind === expectedKind && (value.user_id === null || uuid(value.user_id)) &&
    text(value.display_name) && nullableText(value.agent_tool) && nullableText(value.model)
}
function validContextEntry(value, kind) {
  return exact(value, ['message_id', 'order', 'actor', 'source_type', 'relationship', 'content', 'advisory']) &&
    uuid(value.message_id) && validOrder(value.order) && value.message_id === value.order.message_id &&
    validActor(value.actor, kind) && text(value.source_type) && RELATIONSHIPS.has(value.relationship) &&
    typeof value.content === 'string' && value.advisory === true
}
function validContext(value) {
  if (!exact(value, ['human_context', 'agent_context', 'ai_context', 'system_context'])) return false
  for (const [bucket, kind] of [['human_context', 'human'], ['agent_context', 'agent'], ['ai_context', 'ai'], ['system_context', 'system']]) {
    if (!Array.isArray(value[bucket]) || !value[bucket].every((entry) => validContextEntry(entry, kind)) || !ordered(value[bucket])) return false
  }
  return true
}
function validWindow(value) {
  if (!exact(value, ['policy_version', 'returned', 'total_known', 'source_window', 'truncated', 'has_more', 'next_cursor', 'fetch_id', 'omission_reason']) ||
      value.policy_version !== REMOTE_INGRESS_POLICY_VERSION || !integer(value.returned) ||
      !(value.total_known === null || integer(value.total_known)) ||
      !exact(value.source_window, ['start', 'end']) ||
      !(value.source_window.start === null || validOrder(value.source_window.start)) ||
      !(value.source_window.end === null || validOrder(value.source_window.end)) ||
      typeof value.truncated !== 'boolean' || typeof value.has_more !== 'boolean' ||
      !(value.next_cursor === null || text(value.next_cursor)) || !(value.fetch_id === null || text(value.fetch_id)) ||
      !(value.omission_reason === null || OMISSION_REASONS.has(value.omission_reason))) return false
  const { start, end } = value.source_window
  if ((start === null) !== (end === null) || (start && end && start.sequence > end.sequence)) return false
  if (value.has_more && !value.next_cursor) return false
  if (value.truncated && (!value.omission_reason || !value.fetch_id)) return false
  if (value.total_known !== null && value.returned > value.total_known) return false
  return true
}
function validControl(value) {
  if (!exact(value, ['id', 'verb', 'issued_at', 'issued_by_user_id', ...(Object.hasOwn(value, 'args') ? ['args'] : [])]) ||
      !uuid(value.id) || !CONTROL_VERBS.has(value.verb) || !datetime(value.issued_at) || !uuid(value.issued_by_user_id)) return false
  if (Object.hasOwn(value, 'args')) {
    if (!object(value.args) || Object.keys(value.args).some((key) => !['model', 'thinking'].includes(key)) ||
        (Object.hasOwn(value.args, 'model') && !text(value.args.model)) ||
        (Object.hasOwn(value.args, 'thinking') && !THINKING_LEVELS.has(value.args.thinking))) return false
  }
  if (value.verb === 'set_model' && !text(value.args?.model)) return false
  if (value.verb === 'set_thinking' && !THINKING_LEVELS.has(value.args?.thinking)) return false
  return true
}
function sameAddressee(a, b) {
  return a.connection_id === b.connection_id && a.agent_name === b.agent_name && a.codename === b.codename && a.label === b.label
}
function withinWindow(row, window) {
  const { start, end } = window.source_window
  return !!start && !!end && row.order.sequence >= start.sequence && row.order.sequence <= end.sequence
}

/** Validate the authoritative v1 envelope without mutating or projecting it. */
export function validateRemoteIngressEnvelopeV1(envelope, connectionId) {
  if (!exact(envelope, ['kind', 'schema_version', 'contract_version', 'policy_version', 'envelope_id', 'connection', 'wake', 'delivery_state', 'command_message_ids', 'commands', 'control', 'context', 'window'])) return 'malformed canonical ingress envelope'
  if (envelope.kind !== 'devspec.remote_ingress' || envelope.schema_version !== REMOTE_INGRESS_SCHEMA_VERSION ||
      envelope.contract_version !== REMOTE_INGRESS_CONTRACT_VERSION || envelope.policy_version !== REMOTE_INGRESS_POLICY_VERSION) return 'unknown canonical ingress contract version'
  if (!uuid(envelope.envelope_id) || !validAddressee(envelope.connection) || envelope.connection.connection_id !== connectionId) return 'canonical ingress connection mismatch'
  if (!exact(envelope.wake, ['kind', 'active', 'reason_id']) || !WAKE_KINDS.has(envelope.wake.kind) ||
      typeof envelope.wake.active !== 'boolean' || !text(envelope.wake.reason_id)) return 'malformed canonical wake decision'
  const activeKind = envelope.wake.kind === 'conversational_command' || envelope.wake.kind === 'control'
  if (envelope.wake.active !== activeKind || !new Set(['live', 'replay', 'reseed']).has(envelope.delivery_state)) return 'contradictory canonical wake decision'
  if (envelope.delivery_state !== 'live' && (envelope.wake.kind !== 'history_reseed' || envelope.wake.active)) return 'non-live ingress cannot wake'
  if (envelope.wake.kind === 'history_reseed' && envelope.delivery_state === 'live') return 'history ingress cannot be live'
  if (!Array.isArray(envelope.command_message_ids) || !envelope.command_message_ids.every(uuid) ||
      new Set(envelope.command_message_ids).size !== envelope.command_message_ids.length ||
      !Array.isArray(envelope.commands) || !envelope.commands.every(validCommand) || !ordered(envelope.commands)) return 'malformed canonical commands'
  const commandIds = envelope.commands.map((command) => command.message_id)
  if (new Set(commandIds).size !== commandIds.length || commandIds.length !== envelope.command_message_ids.length ||
      envelope.command_message_ids.some((id) => !commandIds.includes(id))) return 'canonical command identity mismatch'
  if (envelope.wake.kind === 'conversational_command' && envelope.commands.length === 0) return 'canonical command wake is empty'
  if (envelope.commands.some((command) => !sameAddressee(command.addressee, envelope.connection))) return 'canonical command addressee mismatch'
  if (envelope.commands.some((command) => command.attachments.some((a) => a.materialization === 'unavailable'))) return 'canonical command attachment unavailable'
  if ((envelope.wake.kind === 'control') !== (envelope.control !== null) || (envelope.control !== null && !validControl(envelope.control))) return 'malformed canonical control'
  if (!validContext(envelope.context) || !validWindow(envelope.window)) return 'malformed canonical context/window'
  const contextRows = Object.values(envelope.context).flat()
  const allRows = [...envelope.commands, ...contextRows]
  if (new Set(allRows.map((row) => row.message_id)).size !== allRows.length || envelope.window.returned !== allRows.length ||
      (allRows.length > 0 && allRows.some((row) => !withinWindow(row, envelope.window)))) return 'canonical ingress window mismatch'
  if (envelope.commands.length > 0) {
    const primary = envelope.commands.filter((command) => command.delivery.is_primary)
    if (primary.length !== 1 || new Set(envelope.commands.map((c) => c.delivery.turn_id)).size !== 1 ||
        new Set(envelope.commands.map((c) => c.delivery.primary_provenance_ref)).size !== 1 ||
        primary[0].delivery.provenance_ref !== primary[0].delivery.primary_provenance_ref) return 'canonical command turn binding mismatch'
  }
  return null
}

/**
 * Poll-acceptance normalizer. Changed responses must contain a valid v1 envelope;
 * legacy top-level command/context arrays are intentionally never consulted.
 */
export function normalizeRemoteIngressV1(response, connectionId) {
  if (!object(response)) return { ok: false, error: 'malformed poll response' }
  if (response.changed !== true) return { ok: true, changed: false, envelope: null, wake: false }
  const error = validateRemoteIngressEnvelopeV1(response.ingress, connectionId)
  if (error) return { ok: false, error }
  const envelope = response.ingress
  const wake = envelope.delivery_state === 'live' && envelope.wake.kind === 'conversational_command' &&
    envelope.wake.active === true && envelope.commands.length > 0
  return { ok: true, changed: true, envelope, wake }
}

export const REMOTE_INGRESS_CONTEXT_BUCKETS = ['human_context', 'agent_context', 'ai_context', 'system_context']

export function emptyCanonicalContextCarry() {
  return {
    context: Object.fromEntries(REMOTE_INGRESS_CONTEXT_BUCKETS.map((bucket) => [bucket, []])),
    windows: [],
    locally_omitted: 0,
  }
}

/** Preserve the existing newest-first bounded carry, independently per typed actor bucket. */
export function mergeCanonicalContextCarry(carry, envelope, { maxCount = 20, maxChars = 12_000 } = {}) {
  const next = emptyCanonicalContextCarry()
  next.windows = [...(Array.isArray(carry?.windows) ? carry.windows : []), envelope.window]
  next.locally_omitted = integer(carry?.locally_omitted) ? carry.locally_omitted : 0
  for (const bucket of REMOTE_INGRESS_CONTEXT_BUCKETS) {
    const rows = [...(Array.isArray(carry?.context?.[bucket]) ? carry.context[bucket] : []), ...envelope.context[bucket]]
    const kept = []
    let chars = 0
    for (let i = rows.length - 1; i >= 0 && kept.length < maxCount; i--) {
      const size = rows[i].content.length
      if (kept.length > 0 && chars + size > maxChars) break
      chars += size
      kept.push(rows[i])
    }
    kept.reverse()
    next.context[bucket] = kept
    next.locally_omitted += rows.length - kept.length
  }
  return next
}

export function canonicalAttachmentDescriptor(attachment) {
  if (attachment?.materialization !== 'metadata' || !uuid(attachment.resource_id)) return null
  return {
    ...attachment,
    delivery: 'resource',
    note: 'Stable DevSpec resource reference; use resource_id when the command requires this attachment.',
  }
}
