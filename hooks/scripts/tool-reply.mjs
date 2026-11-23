/**
 * DevSpec's answer to a tool call, read apart from what DevSpec appends to it (item
 * 75d3b14a; the claim hook learned the same in item ef54cfcb).
 *
 * DevSpec's own answer is the FIRST text block of a tools/call result. When something
 * outside the answer needs saying (the project is paused or the organisation is out of
 * funds or read-only, the request named no plugin, the calling connection is unhealthy,
 * a write changed someone else's record), DevSpec appends it after the answer as one
 * more text block, a JSON object under its own key (`devspec_account_notice`,
 * `devspec_plugin_notice`, `devspec_agent_health`, `tell_person`). Joining the blocks
 * before reading made every such reply unreadable: a registration while the project was
 * paused looked like no registration at all.
 *
 * So the answer is read from the first text block alone, and every text block after it
 * is kept as DevSpec sent it, never dropped: a caller can show a notice or act on it by
 * its key. A block that is not a JSON object is kept as `{ text }`.
 */

/**
 * The key under which `mcpToolsCall` returns a reply's appended blocks beside its
 * answer. The plugin's own name, so it cannot collide with a field of DevSpec's answer.
 */
export const REPLY_NOTICES_KEY = 'devspec_notices'

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * A tools/call result read as DevSpec's answer plus what it appended.
 *
 * - `answerText`: the first text block, or null when the result has none.
 * - `readable`: whether `answerText` is JSON; `answer` is its value then, else undefined.
 * - `notices`: every later text block, in order: its JSON object, or `{ text }`.
 *
 * @param {{ content?: unknown } | null | undefined} result
 * @returns {{ answerText: string|null, readable: boolean, answer: unknown, notices: object[] }}
 */
export function readToolReply(result) {
  const blocks = Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    : []
  const answerText = blocks.length > 0 ? blocks[0].text : null
  let readable = false
  let answer
  if (answerText !== null) {
    try {
      answer = JSON.parse(answerText)
      readable = true
    } catch {
      answer = undefined
    }
  }
  const notices = blocks.slice(1).map((block) => {
    try {
      const value = JSON.parse(block.text)
      if (isPlainObject(value)) return value
    } catch {
      /* kept as text below */
    }
    return { text: block.text }
  })
  return { answerText, readable, answer, notices }
}

/**
 * The value of the first appended notice under `key` (for example
 * `devspec_account_notice`), or null. Accepts a reply's `notices` or an answer that
 * carries them under `REPLY_NOTICES_KEY`.
 */
export function replyNotice(source, key) {
  const notices = Array.isArray(source) ? source : source?.[REPLY_NOTICES_KEY]
  if (!Array.isArray(notices)) return null
  const found = notices.find((notice) => isPlainObject(notice) && Object.hasOwn(notice, key))
  return found ? found[key] : null
}
