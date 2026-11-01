/**
 * The one limit on what this plugin posts into a DevSpec room.
 *
 * DevSpec stores a room message of at most 100,000 characters: the `message` argument
 * of `post_session_message` carries `maxLength: 100000` in the server's tool schema,
 * counted as JavaScript string length, exactly like `String.prototype.length` here.
 * No smaller ceiling is ours to impose (item ac7d624b), so everything the plugin posts
 * — mirrored prompts, question replies, the live work trail, a failed turn's notice —
 * is measured against this single definition.
 *
 * Text is never cut silently. `fitRoomMessage` returns it whole when it fits; when it
 * does not, it keeps the start and says how many characters are not shown and where
 * the rest is, all within the limit.
 */

export const ROOM_MESSAGE_MAX_CHARS = 100_000

/**
 * The note that ends a message too long for the room.
 * @param {number} omitted characters left out
 * @param {string} whereRest one sentence saying where the full text can be read
 */
export function roomMessageCutNote(omitted, whereRest) {
  const where = typeof whereRest === 'string' && whereRest.trim() ? ` ${whereRest.trim()}` : ''
  return (
    `\n\n… ${omitted.toLocaleString('en-US')} more characters are not shown: ` +
    `a DevSpec room message holds at most ${ROOM_MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters.${where}`
  )
}

/**
 * Fit text into one room message: whole when it fits, otherwise its start followed by
 * a visible note naming how much was left out and where the rest is.
 * @param {string} text
 * @param {{ whereRest?: string, max?: number }} [options]
 * @returns {string}
 */
export function fitRoomMessage(text, { whereRest = '', max = ROOM_MESSAGE_MAX_CHARS } = {}) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  // The note's length depends on the count it reports. Size the room for a note that
  // reports the largest possible count, then write the real one, which is never longer.
  const keep = Math.max(0, max - roomMessageCutNote(s.length, whereRest).length)
  return `${s.slice(0, keep)}${roomMessageCutNote(s.length - keep, whereRest)}`
}

/**
 * Why a reply cannot be posted as it is, or null when it fits. For text the agent wrote
 * itself and can shorten, refusing with the numbers beats cutting it on its behalf.
 * @param {string} text
 * @returns {string | null}
 */
export function roomMessageTooLong(text) {
  const length = String(text ?? '').length
  if (length <= ROOM_MESSAGE_MAX_CHARS) return null
  return (
    `this reply is ${length.toLocaleString('en-US')} characters, and a DevSpec room message holds at most ` +
    `${ROOM_MESSAGE_MAX_CHARS.toLocaleString('en-US')}. Nothing was posted. Shorten it, or put the detail in a ` +
    'document (create_resource) and reply with a summary that names it.'
  )
}
