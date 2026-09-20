/**
 * Single source of truth for THIS plugin's agent identity.
 *
 * The agent name is a fixed property of the plugin — not runtime state, not an
 * LLM-passed arg, not a copied fallback. Every script (poller, mirror-turn,
 * remote-control-state) imports AGENT_NAME and uses it as THE identity, so a
 * plugin can never mislabel itself (e.g. as "Grok Build") no matter what's in a
 * stale/foreign state file or whether `--agent` was passed. One line to set per
 * plugin; impossible to drift.
 */
export const AGENT_NAME = 'Cursor'

/**
 * The environment variables THIS host uses for its own conversation id.
 *
 * Own host only. Another host's id is a real id for a real conversation — just
 * not this one — so adopting it is not a near-miss, it is answering as somebody
 * else. That happens whenever one agent launches another, which is now routine:
 * the child inherits the parent's whole environment.
 *
 * This list used to name every host's variable (`CLAUDE_CODE_SESSION_ID`,
 * `CODEX_THREAD_ID`, `GROK_SESSION_ID` …) so that one shared function could
 * serve every plugin. The generality was the bug (item 75f65461).
 *
 * Note the shape, because it is the fix: the function stays shared and
 * tool-agnostic, and the HOST supplies its own names. Hardcoding one host's
 * variable inside the shared resolver is the opposite mistake and broke every
 * non-Claude plugin once already (memory f90e2ff9) — that lesson stands.
 *
 * Cursor also stamps `conversation_id` on its hook payloads, which
 * resolveHookConversationId prefers over env entirely (verified against
 * cursor-agent 2026.08.11: `stop` and `postToolUse` both carry it).
 */
export const CONVERSATION_ID_ENV_VARS = ['CURSOR_CONVERSATION_ID']

/**
 * Explicit override, host-qualified on purpose.
 *
 * The bare `DEVSPEC_REMOTE_LOCAL_ID` is deliberately NOT read: it is the same
 * hazard wearing a neutral name. A parent agent that exports it hands it to
 * every child process it ever spawns, and each one then believes it is that
 * conversation.
 */
export const LOCAL_ID_OVERRIDE_ENV_VAR = 'DEVSPEC_REMOTE_LOCAL_ID_CURSOR'
