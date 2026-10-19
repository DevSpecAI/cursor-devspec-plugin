/**
 * Stamp the request a DevSpec write serves (item 56ba1b79, requests.mjs).
 *
 * Only this plugin knows what woke the agent, so the write carries it: the request
 * the current turn continues, or, for a subagent, the request that launched it.
 * `request_ref` is a host-only parameter DevSpec hides from the model; a tool that
 * does not declare it simply drops it. The model never states attribution: a
 * request_ref it wrote is dropped before the host's is stamped. A call whose
 * subject is a connection is left unstamped. Nothing known stamps nothing, which
 * leaves DevSpec to resolve who asked itself.
 *
 * When the turn carries more than one person's request and the agent has not said
 * which it is working on, a write that records who asked is refused, with the
 * requests it could serve and the one command that names one. Never a guess: a
 * write credited to the wrong person is judged by the wrong person's role.
 */

import os from 'node:os'
import path from 'node:path'
import {
  provenanceRefForWrite,
  readRequestState,
  requestRefForWrite,
  selectableRequests,
  servableCarried,
  turnAmbiguity,
  undecidedTurnMessage,
} from './requests.mjs'

const CONNECTION_SUBJECT = /(?:^|_)connection(?:_|$)|^report_(?:pickup|keepalive|complete|request)$/

/**
 * The DevSpec tools that record who asked for a write and take `request_ref` (the
 * server's `provenance: 'work_claim'` tools). server-tool-names.test.mjs checks
 * this against a devspecv2 checkout beside the plugin.
 */
export const REQUEST_REF_TOOLS = new Set([
  'add_commit_reference',
  'add_implementation_note',
  'archive_resource',
  'classify_criterion',
  'create_task',
  'create_automation',
  'create_resource',
  'decide_proposal',
  'delete_automation',
  'fail_work_item',
  'import_instruction_rules',
  'link_tasks',
  'manage_knowledge_links',
  'manage_protected_intent',
  'record_completed_work',
  'record_criterion_verdicts',
  'record_duplicate_nonmatch',
  'record_implementation',
  'record_memory',
  'release_work_item',
  'reopen_task',
  'resolve_duplicate',
  'resolve_memory_flag',
  'resolve_resource_flag',
  'retract_memory',
  'spin_off_task',
  'supersede_task',
  'supersede_memory',
  'supersede_resource',
  'unlink_tasks',
  'update_task',
  'update_automation',
  'update_memory',
  'update_resource',
  'write_project_instruction_rule',
])

/**
 * The DevSpec tools that accept `provenance_ref`. Verified against devspecv2 in
 * server-tool-names.test.mjs.
 */
export const PROVENANCE_REF_TOOLS = new Set([
  ...REQUEST_REF_TOOLS,
  'claim_work_item',
  'manage_directed_question',
  'preview_supersession',
  'report_request',
  'reserve_work_items',
])

/**
 * @returns {{ args: object } | { deny: string }} the call's arguments, stamped, or
 *   why it is refused
 */
export function stampRequest(
  toolName,
  args,
  connectionId,
  agentId = null,
  { home = os.homedir(), connectionState = null, includeProvenance = false } = {},
) {
  if (!args || typeof args !== 'object') return { args }
  let own = args
  if (Object.hasOwn(args, 'request_ref')) {
    const { request_ref: _written, ...rest } = args
    own = rest
  }
  if (!connectionId || CONNECTION_SUBJECT.test(toolName)) return { args: own }
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  const state = readRequestState(connectionId, { dir })
  const agent = typeof agentId === 'string' && agentId ? agentId : null
  // A write that cites the work it belongs to (work_claim_ref) or the command it
  // serves (provenance_ref) already says whose it is: DevSpec reads those first.
  const cites = typeof own.work_claim_ref === 'string' || typeof own.provenance_ref === 'string'
  const requiresAttribution =
    REQUEST_REF_TOOLS.has(toolName) || (includeProvenance && PROVENANCE_REF_TOOLS.has(toolName))
  const carried = requiresAttribution && !cites ? turnAmbiguity(state, agent) : null
  if (carried) {
    return {
      deny: undecidedTurnMessage(
        connectionId,
        servableCarried(state, selectableRequests(state) ?? carried),
        'this change',
      ),
    }
  }
  const ref = requestRefForWrite(state, agent)
  let next = ref && (!includeProvenance || REQUEST_REF_TOOLS.has(toolName)) ? { ...own, request_ref: ref } : own
  if (includeProvenance && next.provenance_ref === undefined && PROVENANCE_REF_TOOLS.has(toolName)) {
    const provRef =
      provenanceRefForWrite(state, agent) ||
      (typeof connectionState?.provenance_ref === 'string' && connectionState.provenance_ref
        ? connectionState.provenance_ref
        : null)
    if (provRef) {
      next = { ...next, provenance_ref: provRef }
    }
  }
  return { args: next }
}
