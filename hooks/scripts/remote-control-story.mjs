/**
 * Client-side remote-control story breadcrumbs (brief 21ea8ff4).
 *
 * Same phase vocabulary as DevSpec server Axiom rows (`Remote-control story`)
 * and the OpenCode plugin emitter. Writes structured JSON to stderr so the
 * poller's redirected `.poll.log` captures them alongside human lines.
 *
 * Do not log message bodies or model token streams.
 */

/** Shared with server + OpenCode — keep docs in sync when extending. */
export const REMOTE_CONTROL_STORY_PHASES = [
  'register',
  'attach',
  'seed_filter',
  'inject',
  'wake',
  'mirror_decision',
  'mirror_post',
  'complete_turn',
  'pickup',
  'done',
  'poll_error',
  'stall',
  'ended',
]

/**
 * @param {{
 *   phase: string,
 *   outcome: string,
 *   reason?: string | null,
 *   connectionId?: string | null,
 *   sessionId?: string | null,
 *   agent?: string | null,
 *   codename?: string | null,
 *   tool?: string | null,
 *   data?: Record<string, unknown>,
 * }} fields
 */
export function logRemoteControlStory(fields) {
  const {
    phase,
    outcome,
    reason,
    connectionId,
    sessionId,
    agent,
    codename,
    tool,
    data,
  } = fields

  const event = {
    type: 'remote_control_story',
    phase,
    outcome,
    ...(reason != null && reason !== '' ? { reason } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agent ? { agent } : {}),
    ...(codename ? { codename } : {}),
    ...(tool ? { tool } : {}),
    ...(data ?? {}),
  }

  try {
    process.stderr.write(`story ${JSON.stringify(event)}\n`)
  } catch {
    // best-effort
  }
}
