// Pure Cursor-side validator/normalizer for the canonical remote-ingress contract.
// Runtime policy and schema authority: devspec://product/remote-ingress-contract

export const REMOTE_INGRESS_RESOURCE_URI = 'devspec://product/remote-ingress-contract'
export const REMOTE_INGRESS_SCHEMA_VERSION = 1
export const REMOTE_INGRESS_CONTRACT_VERSION = '1.2.0'
export const REMOTE_INGRESS_POLICY_VERSION = '2026-08-19.3'
export const REMOTE_INGRESS_ACTIVE_PLAN_CONTRACT_VERSION = '1.3.0'
export const REMOTE_INGRESS_ACTIVE_PLAN_POLICY_VERSION = '2026-08-21.1'
export const REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION = '1.4.0'
export const REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION = '2026-08-22.1'
export const REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION = '1.5.0'
export const REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION = '2026-09-18.1'
export const REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION = '1.6.0'
export const REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION = '2026-09-24.1'
export const ROOM_CONTEXT_VERSION = 1
// The numeric bounds in this file validate what the server sends and cut nothing
// (the one local bound is CONTEXT_CARRY_BOUNDS, documented there). Each mirrors the served contract's wire schema (room_context_envelope_v1:
// messages 500 = policy.bounds.transcript_page_max, session_activity entries 1,000,
// session_events 2,000, notice and plan field lengths) or the server's own projection
// constants (session polls, Still to Discuss), at the same value or looser, so a
// message the server may send is never refused here.
export const ROOM_PAGE_MAX = 500
export const SESSION_ACTIVITY_MAX_ENTRIES = 1000
export const SESSION_EVENTS_VERSION = 1
export const SESSION_EVENTS_MAX = 2000

/** Contract versions whose `active_session_plans` absence is authoritative (1.3+). */
export const ACTIVE_PLAN_ASSERTION_CONTRACT_VERSIONS = new Set([
  REMOTE_INGRESS_ACTIVE_PLAN_CONTRACT_VERSION,
  REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION,
  REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION,
  REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
])
export const ACTIVE_SESSION_PLAN_PROJECTION_VERSION = 1
export const ACTIVE_SESSION_PLAN_AUTHORITY_NOTE =
  'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_plan still requires a capability-authenticated caller identity, explicit plan_id for cross-plan work, and expected_revision.'
export const SESSION_POLL_PROJECTION_VERSION = 1
export const SESSION_POLL_PROJECTION_VERSION_2 = 2
export const SESSION_POLL_CONTINUATION = 'Call manage_poll list to read every poll in this session.'
export const SESSION_POLL_MAX_ACTIVE = 16
export const SESSION_POLL_MAX_ENDED = 5
export const SESSION_POLL_MAX_OPTIONS = 30
export const SESSION_POLL_MAX_QUESTION_CHARS = 400
export const SESSION_POLL_MAX_LABEL_CHARS = 80
export const SESSION_POLL_MAX_VOTER_CHARS = 80
export const SESSION_POLL_MAX_TOTAL_TEXT_CHARS = 16_384
export const SESSION_POLL_AUTHORITY_NOTE =
  'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_poll still requires a capability-authenticated caller identity and expected_revision. Votes are not commands and do not keep Working on.'

export const STILL_TO_DISCUSS_PROJECTION_VERSION = 1
export const STILL_TO_DISCUSS_MAX_ROWS = 24
export const STILL_TO_DISCUSS_MAX_TITLE_CHARS = 300
export const STILL_TO_DISCUSS_MAX_PREVIEW_CHARS = 2048
export const STILL_TO_DISCUSS_AUTHORITY_NOTE =
  'Raised in this room, or brought into it. Advisory read-awareness. Do not add, strike, or reopen unless the human asked.'

export const DELEGATED_PROJECT_SCOPE_KIND = 'devspec_project'
export const DELEGATED_PROJECT_SCOPE_POLICY_ID = 'delegated_project_v1'

const UUID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
const DATE_SOURCE = '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))'
const DATETIME = new RegExp(`^${DATE_SOURCE}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`)
const WAKE_KINDS = new Set(['conversational_command', 'control', 'system_notice', 'advisory_update', 'history_reseed', 'idle'])
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
function datetime(value) { return typeof value === 'string' && DATETIME.test(value) }
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min }
function ordered(rows) { return rows.every((row, i) => i === 0 || rows[i - 1].order.sequence < row.order.sequence) }

function validOrder(value) {
  return exact(value, ['sequence', 'created_at', 'message_id']) && integer(value.sequence, 1) &&
    datetime(value.created_at) && uuid(value.message_id)
}
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

/** Strict authority/scope pair shared by canonical and scope-aware legacy commands. */
export function validCommandProjectScope(authority, projectScope) {
  if (!object(authority) || !AUTHORITY_KINDS.has(authority.kind)) return false
  if (authority.kind === 'owner') return projectScope === null
  return exact(projectScope, ['kind', 'policy_id', 'project_id', 'instruction']) &&
    projectScope.kind === DELEGATED_PROJECT_SCOPE_KIND &&
    projectScope.policy_id === DELEGATED_PROJECT_SCOPE_POLICY_ID &&
    uuid(projectScope.project_id) && text(projectScope.instruction)
}

function validCommand(value) {
  if (!exact(value, ['message_id', 'order', 'content', 'attachments', 'requester', 'authority', 'addressee', 'delivery', 'project_scope']) ||
      !uuid(value.message_id) || !validOrder(value.order) || value.message_id !== value.order.message_id ||
      !exact(value.content, ['mode', 'body', 'complete']) || value.content.mode !== 'full' ||
      typeof value.content.body !== 'string' || value.content.complete !== true ||
      !Array.isArray(value.attachments) || !value.attachments.every(validAttachment) ||
      !exact(value.requester, ['user_id', 'display_name']) || !uuid(value.requester.user_id) ||
      !nullableText(value.requester.display_name) || !validAuthority(value.authority) ||
      !validCommandProjectScope(value.authority, value.project_scope) ||
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
function validWindow(value, policyVersion = null) {
  const supportedPolicy = policyVersion
    ? value?.policy_version === policyVersion
    : new Set([
        REMOTE_INGRESS_POLICY_VERSION,
        REMOTE_INGRESS_ACTIVE_PLAN_POLICY_VERSION,
        REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION,
        REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION,
        REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
      ]).has(value?.policy_version)
  if (!exact(value, ['policy_version', 'returned', 'total_known', 'source_window', 'truncated', 'has_more', 'next_cursor', 'fetch_id', 'omission_reason']) ||
      !supportedPolicy || !integer(value.returned) ||
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
function validPlanAgentIdentity(value) {
  if (!exact(value, ['kind', 'connection_id', 'agent_name', 'codename']) ||
      !new Set(['dev', 'connection']).has(value.kind) || !text(value.agent_name) ||
      value.agent_name.length > 300 || !(value.codename === null || (text(value.codename) && value.codename.length <= 300))) return false
  return value.kind === 'dev' ? value.connection_id === null : uuid(value.connection_id)
}
function validPlanStep(value) {
  if (!object(value)) return false
  const failed = value.status === 'failed'
  const keys = ['id', 'position', 'title', 'status', ...(failed && Object.hasOwn(value, 'failure_reason') ? ['failure_reason'] : []), ...(failed ? ['retryable'] : [])]
  return exact(value, keys) && uuid(value.id) && Number.isSafeInteger(value.position) && text(value.title) &&
    value.title.length <= 300 && new Set(['pending', 'in_progress', 'completed', 'failed', 'skipped']).has(value.status) &&
    (!failed || ((value.failure_reason === undefined || (text(value.failure_reason) && value.failure_reason.length <= 4096)) && typeof value.retryable === 'boolean'))
}
function validActiveSessionPlan(value) {
  if (!exact(value, ['id', 'title', 'revision', 'status', 'created_at', 'origin', 'steward', 'owner', 'orphaned', 'progress', 'steps']) ||
      !uuid(value.id) || !text(value.title) || value.title.length > 300 || !integer(value.revision, 1) ||
      value.status !== 'active' || !datetime(value.created_at) || !validPlanAgentIdentity(value.origin) ||
      !validPlanAgentIdentity(value.steward) || !exact(value.owner, ['user_id', 'display_name']) ||
      !uuid(value.owner.user_id) || !text(value.owner.display_name) || value.owner.display_name.length > 300 ||
      typeof value.orphaned !== 'boolean' || !exact(value.progress, ['terminal', 'total', 'completed', 'skipped']) ||
      !Object.values(value.progress).every((count) => integer(count)) || !Array.isArray(value.steps) ||
      value.steps.length > 64 || !value.steps.every(validPlanStep)) return false
  const completed = value.steps.filter((step) => step.status === 'completed').length
  const skipped = value.steps.filter((step) => step.status === 'skipped').length
  return value.progress.total === value.steps.length && value.progress.completed === completed &&
    value.progress.skipped === skipped && value.progress.terminal === completed + skipped
}
function validActiveSessionPlans(value) {
  if (!exact(value, ['version', 'advisory', 'authority_note', 'inventory', 'plans']) ||
      value.version !== ACTIVE_SESSION_PLAN_PROJECTION_VERSION || value.advisory !== true ||
      value.authority_note !== ACTIVE_SESSION_PLAN_AUTHORITY_NOTE ||
      !exact(value.inventory, ['returned', 'total_known', 'truncated']) || value.inventory.truncated !== false ||
      !Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 64 ||
      !value.plans.every(validActiveSessionPlan) || value.inventory.returned !== value.plans.length ||
      value.inventory.total_known !== value.plans.length) return false
  const totalText = value.plans.reduce((total, plan) => total + plan.title.length + plan.origin.agent_name.length +
    (plan.origin.codename?.length ?? 0) + plan.steward.agent_name.length + (plan.steward.codename?.length ?? 0) +
    plan.owner.display_name.length + plan.steps.reduce((sum, step) => sum + step.title.length + (step.failure_reason?.length ?? 0), 0), 0)
  return totalText <= 131_072
}
export function isActiveSessionPlansProjectionV1(value) {
  return validActiveSessionPlans(value)
}

function pollOption(value) {
  return (
    exact(value, ['label', 'human_vote_count', 'percent', 'voters']) &&
    text(value.label) && value.label.length <= SESSION_POLL_MAX_LABEL_CHARS &&
    integer(value.human_vote_count) &&
    integer(value.percent) &&
    Array.isArray(value.voters) && value.voters.length <= 32 &&
    value.voters.every((voter) => text(voter) && voter.length <= SESSION_POLL_MAX_VOTER_CHARS)
  )
}

function validPoll(value) {
  return (
    exact(value, [
      'id', 'question', 'status', 'revision', 'multi_select', 'allow_write_in',
      'recommendation', 'human_voter_count', 'winning_labels', 'options',
    ]) &&
    uuid(value.id) &&
    text(value.question) && value.question.length <= SESSION_POLL_MAX_QUESTION_CHARS &&
    (value.status === 'active' || value.status === 'ended') &&
    integer(value.revision, 1) &&
    typeof value.multi_select === 'boolean' &&
    typeof value.allow_write_in === 'boolean' &&
    (value.recommendation === null || (text(value.recommendation) && value.recommendation.length <= SESSION_POLL_MAX_LABEL_CHARS)) &&
    integer(value.human_voter_count) &&
    Array.isArray(value.winning_labels) &&
    value.winning_labels.length <= SESSION_POLL_MAX_OPTIONS &&
    value.winning_labels.every((label) => text(label) && label.length <= SESSION_POLL_MAX_LABEL_CHARS) &&
    Array.isArray(value.options) &&
    value.options.length >= 2 && value.options.length <= SESSION_POLL_MAX_OPTIONS &&
    value.options.every(pollOption)
  )
}

function pollTextChars(polls) {
  return polls.reduce((sum, entry) => sum + entry.question.length +
    (entry.recommendation?.length ?? 0) +
    entry.winning_labels.reduce((n, label) => n + label.length, 0) +
    entry.options.reduce((n, option) => n + option.label.length +
      option.voters.reduce((v, voter) => v + voter.length, 0), 0), 0)
}

export function isSessionPollsProjectionV1(value) {
  if (!exact(value, ['version', 'advisory', 'authority_note', 'inventory', 'polls']) ||
      value.version !== SESSION_POLL_PROJECTION_VERSION || value.advisory !== true ||
      value.authority_note !== SESSION_POLL_AUTHORITY_NOTE ||
      !exact(value.inventory, ['active_returned', 'ended_returned', 'truncated_ended']) ||
      !integer(value.inventory.active_returned) ||
      value.inventory.active_returned > SESSION_POLL_MAX_ACTIVE ||
      !integer(value.inventory.ended_returned) ||
      value.inventory.ended_returned > SESSION_POLL_MAX_ENDED ||
      typeof value.inventory.truncated_ended !== 'boolean' ||
      !Array.isArray(value.polls) || value.polls.length < 1 ||
      value.polls.length > SESSION_POLL_MAX_ACTIVE + SESSION_POLL_MAX_ENDED ||
      !value.polls.every(validPoll) ||
      new Set(value.polls.map((entry) => entry.id)).size !== value.polls.length) return false
  const active = value.polls.filter((entry) => entry.status === 'active').length
  const ended = value.polls.filter((entry) => entry.status === 'ended').length
  if (active !== value.inventory.active_returned || ended !== value.inventory.ended_returned) return false
  return pollTextChars(value.polls) <= SESSION_POLL_MAX_TOTAL_TEXT_CHARS
}

export function isSessionPollsProjectionV2(value) {
  if (!exact(value, ['version', 'advisory', 'authority_note', 'inventory', 'polls']) ||
      value.version !== SESSION_POLL_PROJECTION_VERSION_2 || value.advisory !== true ||
      value.authority_note !== SESSION_POLL_AUTHORITY_NOTE) return false
  const inv = value.inventory
  if (!exact(inv, ['active_total', 'active_returned', 'truncated_active', 'ended_total', 'ended_returned', 'truncated_ended', 'continuation']) ||
      ![inv.active_total, inv.active_returned, inv.ended_total, inv.ended_returned].every((n) => integer(n)) ||
      inv.ended_returned > SESSION_POLL_MAX_ENDED ||
      inv.active_returned > inv.active_total || inv.ended_returned > inv.ended_total ||
      inv.truncated_active !== (inv.active_returned < inv.active_total) ||
      inv.truncated_ended !== (inv.ended_returned < inv.ended_total) ||
      inv.continuation !== ((inv.truncated_active || inv.truncated_ended) ? SESSION_POLL_CONTINUATION : null) ||
      inv.active_total + inv.ended_total === 0 ||
      !Array.isArray(value.polls) || !value.polls.every(validPoll) ||
      new Set(value.polls.map((entry) => entry.id)).size !== value.polls.length) return false
  const active = value.polls.filter((entry) => entry.status === 'active').length
  const ended = value.polls.filter((entry) => entry.status === 'ended').length
  if (active !== inv.active_returned || ended !== inv.ended_returned) return false
  return pollTextChars(value.polls) <= SESSION_POLL_MAX_TOTAL_TEXT_CHARS
}

export function isSessionPollsProjection(value) {
  return isSessionPollsProjectionV1(value) || isSessionPollsProjectionV2(value)
}

function validDiscussionPoint(value) {
  return (
    exact(value, ['id', 'title', 'state', 'preview']) &&
    uuid(value.id) &&
    text(value.title) && value.title.length <= STILL_TO_DISCUSS_MAX_TITLE_CHARS &&
    (value.state === 'open' || value.state === 'discussed') &&
    typeof value.preview === 'string' && value.preview.length <= STILL_TO_DISCUSS_MAX_PREVIEW_CHARS
  )
}

export function isStillToDiscussProjectionV1(value) {
  return (
    exact(value, ['version', 'advisory', 'authority_note', 'truncated', 'rows']) &&
    value.version === STILL_TO_DISCUSS_PROJECTION_VERSION && value.advisory === true &&
    value.authority_note === STILL_TO_DISCUSS_AUTHORITY_NOTE &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.rows) && value.rows.length >= 1 &&
    value.rows.length <= STILL_TO_DISCUSS_MAX_ROWS &&
    value.rows.every(validDiscussionPoint) &&
    new Set(value.rows.map((row) => row.id)).size === value.rows.length
  )
}

function sameAddressee(a, b) {
  return a.connection_id === b.connection_id && a.agent_name === b.agent_name && a.codename === b.codename && a.label === b.label
}
function withinWindow(row, window) {
  const { start, end } = window.source_window
  return !!start && !!end && row.order.sequence >= start.sequence && row.order.sequence <= end.sequence
}

export const SYSTEM_NOTICE_VERSION = 1
export const READABLE_SYSTEM_NOTICE_KINDS = Object.freeze(['unlinked_commit_item_review', 'server_notice'])
const FULL_LOWERCASE_SHA = /^[0-9a-f]{40}$/
const NOTICE_KIND = /^[a-z][a-z0-9_.-]{0,119}$/
const UNLINKED_COMMIT_NOTICE_OUTCOMES = [
  'correct_item',
  'link_item',
  'resolve_duplicate',
  'dismiss_item',
  'confirm_item_correct',
  'defer_follow_up',
]
const UNLINKED_COMMIT_NOTICE_TOOLS = [
  'get_task',
  'update_task',
  'link_tasks',
  'supersede_task',
]

function exactStringTuple(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  )
}

function serverNoticeRecord(value) {
  return (
    exact(value, ['label', 'record_type', 'record_id', 'title', 'text', 'url']) &&
    text(value.label) && value.label.length <= 200 &&
    text(value.record_type) && value.record_type.length <= 120 &&
    text(value.record_id) && value.record_id.length <= 200 &&
    (value.title === null || (text(value.title) && value.title.length <= 500)) &&
    text(value.text) && value.text.length <= 8000 &&
    (value.url === null || (text(value.url) && value.url.length <= 1000))
  )
}

export function isSystemNoticeV1(value) {
  if (!object(value) || value.version !== SYSTEM_NOTICE_VERSION || value.contract_uri !== REMOTE_INGRESS_RESOURCE_URI) {
    return false
  }
  if (value.kind === 'unlinked_commit_item_review') {
    const keys = [
      'version', 'kind', 'notice_id', 'commit_sha', 'task_id',
      'task_title', 'branch', ...(Object.hasOwn(value, 'prompt') ? ['prompt'] : []),
      'contract_uri', 'allowed_outcomes', 'allowed_tools',
    ]
    return (
      exact(value, keys) &&
      uuid(value.notice_id) &&
      typeof value.commit_sha === 'string' && FULL_LOWERCASE_SHA.test(value.commit_sha) &&
      uuid(value.task_id) &&
      text(value.task_title) && value.task_title.length <= 500 &&
      text(value.branch) && value.branch.length <= 500 &&
      (!Object.hasOwn(value, 'prompt') || (text(value.prompt) && value.prompt.length <= 8000)) &&
      exactStringTuple(value.allowed_outcomes, UNLINKED_COMMIT_NOTICE_OUTCOMES) &&
      exactStringTuple(value.allowed_tools, UNLINKED_COMMIT_NOTICE_TOOLS)
    )
  }
  if (value.kind === 'server_notice') {
    return (
      exact(value, [
        'version', 'kind', 'notice_id', 'topic', 'notice_type',
        'summary', 'prompt', 'contract_uri', 'records', 'allowed_outcomes', 'allowed_tools',
      ]) &&
      uuid(value.notice_id) &&
      text(value.topic) && value.topic.length <= 120 &&
      text(value.notice_type) && value.notice_type.length <= 120 &&
      text(value.summary) && value.summary.length <= 500 &&
      text(value.prompt) && value.prompt.length <= 8000 &&
      Array.isArray(value.records) && value.records.length >= 1 && value.records.length <= 10 &&
      value.records.every(serverNoticeRecord) &&
      Array.isArray(value.allowed_outcomes) && value.allowed_outcomes.length <= 16 &&
      value.allowed_outcomes.every((entry) => text(entry) && entry.length <= 120) &&
      Array.isArray(value.allowed_tools) && value.allowed_tools.length <= 16 &&
      value.allowed_tools.every((entry) => text(entry) && entry.length <= 120)
    )
  }
  return false
}

export function isUnreadableSystemNoticeV1(value) {
  return (
    object(value) &&
    value.version === SYSTEM_NOTICE_VERSION &&
    value.contract_uri === REMOTE_INGRESS_RESOURCE_URI &&
    typeof value.kind === 'string' && NOTICE_KIND.test(value.kind) &&
    !READABLE_SYSTEM_NOTICE_KINDS.includes(value.kind) &&
    uuid(value.notice_id)
  )
}

/** Sender response style for one delivered command (item 7c421a20). Read verbatim, never recomputed. */
export function isSenderResponseStyleV1(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!exact(value, ['message_id', 'notes'])) return false
  if (!uuid(value.message_id)) return false
  if (!Array.isArray(value.notes) || value.notes.length === 0 || value.notes.length > 8) return false
  return value.notes.every((note) => typeof note === 'string' && note.length > 0)
}

const ROOM_MESSAGE_STATES = new Set(['final', 'in_progress', 'deleted'])
const OPEN_CHECK_STATES = new Set(['final', 'in_progress', 'deleted', 'absent'])
const SHA256 = /^sha256:[a-f0-9]{64}$/

function optionalExact(value, required, optional = []) {
  if (!object(value)) return false
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function roomAddressee(value) {
  if (!object(value)) return false
  if (value.kind === 'connection') {
    return exact(value, ['kind', 'connection_id', 'label']) && uuid(value.connection_id) && text(value.label)
  }
  return (value.kind === 'dev' || value.kind === 'room') && exact(value, ['kind'])
}

function roomMessage(value) {
  return (
    exact(value, ['message_id', 'addressee', 'attachments', 'state']) &&
    uuid(value.message_id) &&
    roomAddressee(value.addressee) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(validAttachment) &&
    ROOM_MESSAGE_STATES.has(value.state)
  )
}

function uniqueUuids(list, max) {
  return Array.isArray(list) && list.length <= max && list.every(uuid) && new Set(list).size === list.length
}

function roomCoverage(value) {
  return (
    exact(value, ['through', 'eligible_count', 'deleted_count', 'open_message_ids']) &&
    validOrder(value.through) &&
    integer(value.eligible_count) &&
    integer(value.deleted_count) &&
    uniqueUuids(value.open_message_ids, ROOM_PAGE_MAX) &&
    value.deleted_count + value.open_message_ids.length <= value.eligible_count
  )
}

function validAnyContextEntry(value) {
  return exact(value, ['message_id', 'order', 'actor', 'source_type', 'relationship', 'content', 'advisory']) &&
    uuid(value.message_id) && validOrder(value.order) && value.message_id === value.order.message_id &&
    object(value.actor) && ACTOR_KINDS.has(value.actor.kind) && validActor(value.actor, value.actor.kind) &&
    text(value.source_type) && RELATIONSHIPS.has(value.relationship) &&
    typeof value.content === 'string' && value.advisory === true
}

function roomOpenCheck(value) {
  if (!Array.isArray(value) || value.length > ROOM_PAGE_MAX) return false
  const ids = new Set()
  for (const check of value) {
    if (!optionalExact(check, ['message_id', 'state'], ['entry'])) return false
    if (!uuid(check.message_id) || !OPEN_CHECK_STATES.has(check.state)) return false
    const hasEntry = Object.hasOwn(check, 'entry')
    if ((check.state === 'final') !== hasEntry) return false
    if (hasEntry && (!validAnyContextEntry(check.entry) || check.entry.message_id !== check.message_id)) return false
    const key = check.message_id.toLowerCase()
    if (ids.has(key)) return false
    ids.add(key)
  }
  return true
}

function deletionPoint(value) {
  return exact(value, ['deleted_at', 'message_id']) && datetime(value.deleted_at) && uuid(value.message_id)
}

export function isRoomDeletionsSeen(value) {
  return (
    exact(value, ['through', 'total']) &&
    (value.through === null || deletionPoint(value.through)) &&
    (value.total === null || integer(value.total))
  )
}

function roomDeletions(value) {
  return (
    exact(value, ['message_ids', 'truncated', 'total', 'seen']) &&
    uniqueUuids(value.message_ids, ROOM_PAGE_MAX) &&
    typeof value.truncated === 'boolean' &&
    integer(value.total) &&
    value.message_ids.length <= value.total &&
    isRoomDeletionsSeen(value.seen) &&
    (value.message_ids.length === 0 || value.seen.through !== null) &&
    (!value.truncated || value.message_ids.length > 0) &&
    value.seen.total === (value.truncated ? null : value.total)
  )
}

export function isRoomContextV1(value) {
  if (!optionalExact(value, ['version', 'messages', 'coverage'], ['open_check', 'deletions'])) return false
  if (value.version !== ROOM_CONTEXT_VERSION) return false
  if (!Array.isArray(value.messages) || value.messages.length > ROOM_PAGE_MAX || !value.messages.every(roomMessage)) {
    return false
  }
  if (!(value.coverage === null || roomCoverage(value.coverage))) return false
  if (Object.hasOwn(value, 'open_check') && !(value.open_check === null || roomOpenCheck(value.open_check))) return false
  if (Object.hasOwn(value, 'deletions') && !(value.deletions === null || roomDeletions(value.deletions))) return false
  return true
}

function activityEntry(value) {
  return (
    exact(value, ['kind', 'id', 'title', 'status', 'relation', 'creator']) &&
    ['task', 'memory', 'artifact'].includes(value.kind) &&
    uuid(value.id) &&
    text(value.title) &&
    nullableText(value.status) &&
    ['produced', 'referenced'].includes(value.relation) &&
    (value.creator === null || (
      exact(value.creator, ['kind', 'label']) &&
      ['agent', 'person', 'platform'].includes(value.creator.kind) &&
      text(value.creator.label)
    ))
  )
}

export function isSessionActivityV1(value) {
  if (!exact(value, ['version', 'advisory', 'status', 'as_of', 'revision', 'entries', 'truncated'])) return false
  if (value.version !== 1 || value.advisory !== true || !datetime(value.as_of)) return false
  if (!['available', 'unavailable'].includes(value.status) || typeof value.truncated !== 'boolean') return false
  if (!(value.revision === null || (typeof value.revision === 'string' && SHA256.test(value.revision)))) return false
  if (!Array.isArray(value.entries) || value.entries.length > SESSION_ACTIVITY_MAX_ENTRIES ||
      !value.entries.every(activityEntry)) return false
  const keys = value.entries.map((entry) => `${entry.kind}:${entry.id}`)
  if (new Set(keys).size !== keys.length) return false
  if (value.status === 'unavailable') {
    return value.entries.length === 0 && value.revision === null && value.truncated === false
  }
  return value.revision !== null
}

function eventActor(value) {
  return value === null || (
    exact(value, ['kind', 'label']) &&
    ['agent', 'person', 'platform'].includes(value.kind) &&
    text(value.label)
  )
}

const EVENT_BASE_KEYS = ['id', 'at', 'kind', 'record_id', 'event']

function sessionEvent(value) {
  if (!value || typeof value !== 'object') return false
  const base =
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200 &&
    datetime(value.at) &&
    ['task', 'memory', 'artifact'].includes(value.kind) &&
    uuid(value.record_id)
  if (!base) return false
  switch (value.event) {
    case 'produced':
    case 'retracted':
    case 'archived':
      return exact(value, [...EVENT_BASE_KEYS, 'actor']) && eventActor(value.actor)
    case 'referenced':
      return exact(value, [...EVENT_BASE_KEYS, 'message_id']) && uuid(value.message_id)
    case 'lifecycle_changed':
      return exact(value, [...EVENT_BASE_KEYS, 'from', 'to']) &&
        value.kind === 'task' && text(value.from) && text(value.to)
    case 'superseded':
      return exact(value, [...EVENT_BASE_KEYS, 'by', 'actor']) &&
        (value.by === null || uuid(value.by)) && eventActor(value.actor)
    default:
      return false
  }
}

export function isSessionEventsV1(value) {
  if (!exact(value, ['version', 'advisory', 'status', 'as_of', 'revision', 'events', 'truncated'])) return false
  if (value.version !== SESSION_EVENTS_VERSION || value.advisory !== true || !datetime(value.as_of)) return false
  if (!['available', 'unchanged', 'unavailable'].includes(value.status) || typeof value.truncated !== 'boolean') return false
  if (!(value.revision === null || (typeof value.revision === 'string' && SHA256.test(value.revision)))) return false
  if (!Array.isArray(value.events) || value.events.length > SESSION_EVENTS_MAX || !value.events.every(sessionEvent)) return false
  const ids = value.events.map((event) => event.id)
  if (new Set(ids).size !== ids.length) return false
  if (value.status === 'unavailable') {
    return value.events.length === 0 && value.revision === null && value.truncated === false
  }
  if (value.status === 'unchanged' && value.events.length > 0) return false
  return value.revision !== null
}

function roomContextCrossCheck(value, allRows) {
  const room = value.room_context
  const emitted = new Set(allRows.map((row) => row.message_id))
  const described = room.messages.map((message) => message.message_id)
  if (new Set(described).size !== described.length || described.length !== emitted.size ||
      described.some((id) => !emitted.has(id))) {
    return 'room context must describe every emitted record exactly once'
  }
  const stateById = new Map(room.messages.map((message) => [message.message_id, message.state]))
  if (value.commands.some((entry) => stateById.get(entry.message_id) !== 'final')) {
    return 'a delivered command must be a final, present message'
  }
  if (room.coverage) {
    const { through } = room.coverage
    const end = value.window.source_window.end
    if (end) {
      if (through.sequence !== end.sequence || through.message_id !== end.message_id ||
          Date.parse(through.created_at) !== Date.parse(end.created_at)) {
        return 'coverage point must be the end of this envelope source window'
      }
    } else if (allRows.length > 0) {
      return 'coverage point must be the end of this envelope source window'
    }
    if (room.coverage.eligible_count < allRows.length) return 'eligible_count below emitted records'
    const open = new Set(room.coverage.open_message_ids)
    const describedDeleted = room.messages.filter((message) => message.state === 'deleted').length
    if (room.messages.some((message) => (message.state === 'in_progress') !== open.has(message.message_id)) ||
        describedDeleted > room.coverage.deleted_count) {
      return 'coverage contradicts the states this page describes'
    }
  }
  if (Array.isArray(room.open_check) && room.open_check.some((check) => emitted.has(check.message_id))) {
    return 'open_check answers rows outside this page only'
  }
  return null
}

/** Validate the authoritative v1 envelope without mutating or projecting it. */
export function validateRemoteIngressEnvelopeV1(envelope, connectionId) {
  const roomContextContract = envelope?.contract_version === REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION &&
    envelope?.policy_version === REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION
  const senderStyleContract = roomContextContract ||
    (envelope?.contract_version === REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION &&
      envelope?.policy_version === REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION)
  const noticeContract = senderStyleContract ||
    (envelope?.contract_version === REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION &&
      envelope?.policy_version === REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION)
  const activePlanContract = envelope?.contract_version === REMOTE_INGRESS_ACTIVE_PLAN_CONTRACT_VERSION &&
    envelope?.policy_version === REMOTE_INGRESS_ACTIVE_PLAN_POLICY_VERSION
  const scopedContract = envelope?.contract_version === REMOTE_INGRESS_CONTRACT_VERSION &&
    envelope?.policy_version === REMOTE_INGRESS_POLICY_VERSION
  // active_session_plans is optional across every tier that carries it (1.3+);
  // system_notices is required on 1.4+; sender_response_styles is optional on 1.5+;
  // room_context is required on 1.6+, and session_activity / session_events are optional on 1.6+.
  const activePlanAware = activePlanContract || noticeContract
  const keys = [
    'kind', 'schema_version', 'contract_version', 'policy_version', 'envelope_id', 'connection',
    'wake', 'delivery_state', 'command_message_ids', 'commands', 'control', 'context',
    ...(activePlanAware && Object.hasOwn(envelope, 'active_session_plans') ? ['active_session_plans'] : []),
    ...(noticeContract ? ['system_notices'] : []),
    ...(senderStyleContract && Object.hasOwn(envelope, 'sender_response_styles') ? ['sender_response_styles'] : []),
    ...(roomContextContract ? ['room_context'] : []),
    ...(roomContextContract && Object.hasOwn(envelope, 'session_activity') ? ['session_activity'] : []),
    ...(roomContextContract && Object.hasOwn(envelope, 'session_events') ? ['session_events'] : []),
    'window',
  ]
  if (!exact(envelope, keys)) return 'malformed canonical ingress envelope'
  if (envelope.kind !== 'devspec.remote_ingress' || envelope.schema_version !== REMOTE_INGRESS_SCHEMA_VERSION ||
      (!activePlanContract && !scopedContract && !noticeContract)) return 'unknown canonical ingress contract version'
  if (activePlanAware && Object.hasOwn(envelope, 'active_session_plans') &&
      !validActiveSessionPlans(envelope.active_session_plans)) return 'malformed active session plan projection'
  if (noticeContract) {
    if (!Array.isArray(envelope.system_notices) || envelope.system_notices.length > 25) return 'malformed system notices'
    const hasNotices = envelope.system_notices.length > 0
    if (hasNotices !== (envelope.wake.kind === 'system_notice')) return 'system notices must be nonempty iff wake kind is system_notice'
    if (hasNotices && (envelope.commands.length > 0 || envelope.control !== null)) return 'system notices cannot accompany commands or control'
    if (hasNotices && (!envelope.system_notices.every((notice) => isSystemNoticeV1(notice) || isUnreadableSystemNoticeV1(notice)) ||
        new Set(envelope.system_notices.map((notice) => notice.notice_id)).size !== envelope.system_notices.length)) {
      return 'malformed system notices'
    }
  }
  if (senderStyleContract && Object.hasOwn(envelope, 'sender_response_styles')) {
    const styles = envelope.sender_response_styles
    if (!Array.isArray(styles) || !styles.every(isSenderResponseStyleV1)) return 'invalid sender response styles'
    const delivered = new Set(envelope.command_message_ids)
    const ids = styles.map((style) => style.message_id)
    if (ids.some((id) => !delivered.has(id)) || new Set(ids).size !== ids.length) return 'sender response style must name a delivered command exactly once'
  }
  if (roomContextContract && !isRoomContextV1(envelope.room_context)) return 'invalid room_context'
  if (roomContextContract && Object.hasOwn(envelope, 'session_activity') && !isSessionActivityV1(envelope.session_activity)) {
    return 'invalid session_activity'
  }
  if (roomContextContract && Object.hasOwn(envelope, 'session_events') && !isSessionEventsV1(envelope.session_events)) {
    return 'invalid session_events'
  }
  if (!uuid(envelope.envelope_id) || !validAddressee(envelope.connection) || envelope.connection.connection_id !== connectionId) return 'canonical ingress connection mismatch'
  if (!exact(envelope.wake, ['kind', 'active', 'reason_id']) || !WAKE_KINDS.has(envelope.wake.kind) ||
      typeof envelope.wake.active !== 'boolean' || !text(envelope.wake.reason_id)) return 'malformed canonical wake decision'
  const activeKind = envelope.wake.kind === 'conversational_command' || envelope.wake.kind === 'control' || envelope.wake.kind === 'system_notice'
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
  if (!validContext(envelope.context) || !validWindow(envelope.window, envelope.policy_version)) return 'malformed canonical context/window'
  const contextRows = Object.values(envelope.context).flat()
  const allRows = [...envelope.commands, ...contextRows]
  if (new Set(allRows.map((row) => row.message_id)).size !== allRows.length || envelope.window.returned !== allRows.length ||
      (allRows.length > 0 && allRows.some((row) => !withinWindow(row, envelope.window)))) return 'canonical ingress window mismatch'
  if (roomContextContract) {
    const roomError = roomContextCrossCheck(envelope, allRows)
    if (roomError) return roomError
  }
  if (envelope.commands.length > 0) {
    const sharedPrimaryRef = envelope.commands[0].delivery.primary_provenance_ref
    const provenanceRefs = envelope.commands.map((command) => command.delivery.provenance_ref)
    const primaryFlagsMatch = envelope.commands.every((command) =>
      command.delivery.is_primary === (command.delivery.provenance_ref === sharedPrimaryRef)
    )
    if (new Set(envelope.commands.map((c) => c.delivery.turn_id)).size !== 1 ||
        new Set(envelope.commands.map((c) => c.delivery.primary_provenance_ref)).size !== 1 ||
        new Set(provenanceRefs).size !== provenanceRefs.length || !primaryFlagsMatch) return 'canonical command turn binding mismatch'
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
  const conversationalWake = envelope.delivery_state === 'live' && envelope.wake.kind === 'conversational_command' &&
    envelope.wake.active === true && envelope.commands.length > 0
  const systemNoticeWake = envelope.delivery_state === 'live' && envelope.wake.kind === 'system_notice' &&
    envelope.wake.active === true && Array.isArray(envelope.system_notices) && envelope.system_notices.length > 0
  const wake = conversationalWake || systemNoticeWake
  return { ok: true, changed: true, envelope, wake, reason: envelope.wake.kind }
}

export const REMOTE_INGRESS_CONTEXT_BUCKETS = ['human_context', 'agent_context', 'ai_context', 'system_context']

export function emptyCanonicalContextCarry() {
  return {
    context: Object.fromEntries(REMOTE_INGRESS_CONTEXT_BUCKETS.map((bucket) => [bucket, []])),
    windows: [],
    locally_omitted: 0,
    locally_omitted_by_bucket: Object.fromEntries(REMOTE_INGRESS_CONTEXT_BUCKETS.map((bucket) => [bucket, 0])),
    windows_omitted: 0,
    local_omission_reason: null,
  }
}

/**
 * How much advisory room context a connection carries between polls until a command
 * arrives. One definition, used by the poller that builds the carry and the wait that
 * validates it.
 *
 * Why it is bounded: the carry is rewritten into the connection's state file on every
 * poll for as long as no command comes, so in a busy room it would otherwise grow
 * without end. Nothing the model needs is lost: a canonical wake does not print these
 * rows at all; it names the local room transcript (room-transcript.mjs), which keeps
 * every message whole, and the room is always readable with get_session_transcript.
 * What is left out is counted (`locally_omitted`, by bucket) and labelled
 * `model_budget`, as the ingress contract asks of a bounded working set
 * (`policy.bounds.context_projection_default`: omissions are disclosed).
 */
export const CONTEXT_CARRY_BOUNDS = Object.freeze({ maxCount: 20, maxChars: 12_000, maxWindows: 20 })

/** Strictly bound the complete advisory rows and source-window ledger, newest first. */
export function mergeCanonicalContextCarry(
  carry,
  envelope,
  {
    maxCount = CONTEXT_CARRY_BOUNDS.maxCount,
    maxChars = CONTEXT_CARRY_BOUNDS.maxChars,
    maxWindows = CONTEXT_CARRY_BOUNDS.maxWindows,
  } = {},
) {
  const next = emptyCanonicalContextCarry()
  const priorWindows = Array.isArray(carry?.windows) ? carry.windows : []
  const windowKey = (window) => JSON.stringify([
    window.policy_version,
    window.source_window.start?.sequence ?? null,
    window.source_window.start?.message_id ?? null,
    window.source_window.end?.sequence ?? null,
    window.source_window.end?.message_id ?? null,
    window.fetch_id,
    window.next_cursor,
  ])
  const uniqueWindows = new Map()
  for (const window of [...priorWindows, envelope.window]) uniqueWindows.set(windowKey(window), window)
  const allWindows = [...uniqueWindows.values()]
  next.windows = allWindows.slice(-maxWindows)
  next.windows_omitted = (integer(carry?.windows_omitted) ? carry.windows_omitted : 0) +
    Math.max(0, allWindows.length - next.windows.length)
  next.locally_omitted = integer(carry?.locally_omitted) ? carry.locally_omitted : 0
  for (const bucket of REMOTE_INGRESS_CONTEXT_BUCKETS) {
    next.locally_omitted_by_bucket[bucket] = integer(carry?.locally_omitted_by_bucket?.[bucket])
      ? carry.locally_omitted_by_bucket[bucket]
      : 0
  }

  const taggedById = new Map()
  for (const bucket of REMOTE_INGRESS_CONTEXT_BUCKETS) {
    const prior = Array.isArray(carry?.context?.[bucket]) ? carry.context[bucket] : []
    for (const row of [...prior, ...envelope.context[bucket]]) taggedById.set(row.message_id, { bucket, row })
  }
  const tagged = [...taggedById.values()].sort((a, b) => a.row.order.sequence - b.row.order.sequence)
  const kept = []
  let chars = 0
  for (let i = tagged.length - 1; i >= 0 && kept.length < maxCount; i--) {
    const taggedRow = tagged[i]
    const size = taggedRow.row.content.length
    if (size > maxChars || chars + size > maxChars) continue
    chars += size
    kept.push(taggedRow)
  }
  kept.reverse()
  const keptIds = new Set(kept.map(({ row }) => row.message_id))
  for (const { bucket, row } of tagged) {
    if (keptIds.has(row.message_id)) next.context[bucket].push(row)
    else {
      next.locally_omitted++
      next.locally_omitted_by_bucket[bucket]++
    }
  }
  if (next.locally_omitted > 0 || next.windows_omitted > 0) {
    next.local_omission_reason = 'model_budget'
  }
  return next
}

export function validateCanonicalContextCarry(
  carry,
  {
    maxCount = CONTEXT_CARRY_BOUNDS.maxCount,
    maxChars = CONTEXT_CARRY_BOUNDS.maxChars,
    maxWindows = CONTEXT_CARRY_BOUNDS.maxWindows,
  } = {},
) {
  const hasPlans = Object.hasOwn(carry ?? {}, 'active_session_plans') ||
    Object.hasOwn(carry ?? {}, 'active_session_plan_guidance')
  if (!exact(carry, [
    'advisory', 'typed', 'windows', 'locally_omitted', 'locally_omitted_by_bucket',
    'windows_omitted', 'local_omission_reason',
    ...(hasPlans ? ['active_session_plans', 'active_session_plan_guidance'] : []),
    'note',
  ]) || carry.advisory !== true || !validContext(carry.typed) || !Array.isArray(carry.windows) ||
      (hasPlans && (!validActiveSessionPlans(carry.active_session_plans) ||
        !text(carry.active_session_plan_guidance))) ||
      carry.windows.length > maxWindows || !carry.windows.every((window) => validWindow(window)) ||
      !integer(carry.locally_omitted) || !integer(carry.windows_omitted) ||
      !exact(carry.locally_omitted_by_bucket, REMOTE_INGRESS_CONTEXT_BUCKETS) ||
      REMOTE_INGRESS_CONTEXT_BUCKETS.some((bucket) => !integer(carry.locally_omitted_by_bucket[bucket])) ||
      !(carry.local_omission_reason === null || carry.local_omission_reason === 'model_budget') ||
      typeof carry.note !== 'string') return false
  const rows = Object.values(carry.typed).flat()
  const omittedByBucket = Object.values(carry.locally_omitted_by_bucket)
    .reduce((sum, count) => sum + count, 0)
  return omittedByBucket === carry.locally_omitted && rows.length <= maxCount &&
    rows.reduce((sum, row) => sum + row.content.length, 0) <= maxChars &&
    (carry.locally_omitted > 0 || carry.windows_omitted > 0
      ? carry.local_omission_reason === 'model_budget'
      : carry.local_omission_reason === null)
}

export function canonicalContextAcceptanceKey(envelope) {
  const start = envelope.window.source_window.start
  const end = envelope.window.source_window.end
  return [
    'context-window', envelope.delivery_state, envelope.wake.kind,
    envelope.control?.id ?? 'no-control',
    start ? `${start.sequence}:${start.message_id}` : 'empty',
    end ? `${end.sequence}:${end.message_id}` : 'empty',
    envelope.window.fetch_id ?? 'no-fetch',
  ].join(':')
}

/** Stable across server replay (envelope_id is intentionally not used). */
export function canonicalAcceptanceKey(envelope) {
  if (envelope.wake.kind === 'conversational_command' && envelope.commands.length > 0) {
    const first = envelope.commands[0]
    return `command-messages:${first.delivery.turn_id}:${first.delivery.primary_provenance_ref}:${envelope.command_message_ids.join(',')}`
  }
  if (envelope.wake.kind === 'system_notice' && Array.isArray(envelope.system_notices) && envelope.system_notices.length > 0) {
    return `system-notices:${envelope.system_notices.map((notice) => notice.notice_id).join(',')}`
  }
  if (envelope.wake.kind === 'control' && envelope.control) return `control:${envelope.control.id}`
  return canonicalContextAcceptanceKey(envelope)
}

export function canonicalAttachmentDescriptor(attachment) {
  if (attachment?.materialization !== 'metadata' || !uuid(attachment.resource_id)) return null
  return {
    ...attachment,
    delivery: 'resource',
    note: 'Stable DevSpec resource reference; use resource_id when the command requires this attachment.',
  }
}
