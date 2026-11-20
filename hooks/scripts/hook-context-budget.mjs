/**
 * Cursor's ceiling on the context hooks add to one event, and how the plugin's hooks
 * share it, so nothing a hook hands the agent is ever lost.
 *
 * Measured on cursor-agent 2026.11.05-86047df, 20 November 2026 (DevSpec task
 * 8f940862, live check in a throwaway profile): a postToolUse `additional_context` of
 * 9,900 characters reached the model whole; one of 12,000 was dropped whole, and
 * nothing told the model. The CLI bundle does the same in its hooks carrier: it joins
 * the answers of every hook that answers one event, each trimmed and separated by
 * "\n\n---\n\n", and drops the joined text whole once it is over 10,000 characters.
 * So the plugin's hooks that can answer the same event share the one ceiling, and a
 * long answer from one of them would take every other hook's answer down with it.
 */
export const CURSOR_HOOK_CONTEXT_MAX_CHARS = 10_000

/** What Cursor puts between two hooks' answers to one event. */
export const CURSOR_HOOK_CONTEXT_SEPARATOR = '\n\n---\n\n'

/**
 * The plugin's postToolUse hooks that can add context to the same tool call:
 * project and repository context (repository-context.mjs), the commit note
 * (provenance-assistance.mjs), the repository-link nudge (repo-link-nudge.mjs), the
 * pin check (pin-check.mjs: its two entries match different tools, so one answers),
 * a message the person has not heard (mark-explicit-reply.mjs) and the room's
 * unread count (room-unread.mjs). Adding another means counting it here.
 */
export const POST_TOOL_CONTEXT_HOOKS = 6

/**
 * One hook's share when `hooks` of the plugin's hooks can answer the same event: an
 * equal part of the ceiling once the separators between them are taken out, so their
 * joined answers can never pass it. A hook whose text can be longer than its share
 * hands the whole text over as a file instead and says where.
 */
export function hookContextShare(hooks) {
  const count = Math.max(1, Math.floor(hooks))
  return Math.floor((CURSOR_HOOK_CONTEXT_MAX_CHARS - (count - 1) * CURSOR_HOOK_CONTEXT_SEPARATOR.length) / count)
}

/** A postToolUse hook's share of Cursor's ceiling. */
export const POST_TOOL_CONTEXT_SHARE = hookContextShare(POST_TOOL_CONTEXT_HOOKS)

/** sessionStart has one plugin hook (repository-context.mjs start), so it has the whole ceiling. */
export const SESSION_START_CONTEXT_SHARE = hookContextShare(1)
