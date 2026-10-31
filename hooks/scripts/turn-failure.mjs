/**
 * Tell the room when Cursor could not finish a command (item 9a850303).
 *
 * Cursor runs the stop hook at the end of every interactive turn with `status`
 * "completed", "aborted" or "error". The hook input carries no error text, but Cursor
 * writes the turn's end into the agent transcript the input points to, as
 * `{"type":"turn_ended","status":"error","error":"…"}`. Verified on Cursor CLI
 * 2026.10.19, 2026-10-31: an account at its usage limit fired stop with status "error"
 * and the transcript ended `turn_ended` / "You've hit your usage limit Get Cursor Pro
 * for more Agent usage, unlimited Tab, and more." (Print mode runs no hooks at all.)
 *
 * Before this, stop ignored `status`: the model never answered, so the room stayed
 * silent while the error sat in a terminal the person driving from DevSpec cannot see.
 * An aborted turn told the room nothing either (Brandon, 2026-10-31: tell it).
 *
 * Cursor's text is passed through as written, never reworded or matched on: its
 * messages already say what to do, and Cursor changes them (the same choice the Claude
 * Code and Antigravity plugins made, items b6a38d81 and 408ad47b). With no text the
 * reply still says it couldn't finish, so no failure is ever silent.
 *
 * This is the one case a hook answers a room command (ADR b98a39a9 keeps answers
 * agent-canonical): only a command the turn carries and nobody has answered yet.
 */

import fs from 'node:fs'
import { appendRequestEvent, commandsAnsweredNow, readRequestState } from './requests.mjs'

// How much of the transcript's end is read to find the turn's turn_ended line. Cursor
// writes it as the turn's final line, so it sits within the last few hundred bytes;
// this bound only stops a huge transcript being read whole on every failed turn.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/** Cursor's own error text for the turn that just ended, or null. */
export function lastTurnError(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  let tail
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      tail = buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue // blank, or the partial first line of the tail
    }
    if (entry?.type !== 'turn_ended') continue
    // Only this turn's end counts: a completed turn_ended means no error was written.
    if (entry.status !== 'error') return null
    return typeof entry.error === 'string' && entry.error.trim() ? entry.error.trim() : null
  }
  return null
}

/**
 * The failure as Cursor reported it, or null when the turn completed. Every field is
 * untrusted text from the hook's stdin or the transcript.
 */
export function parseTurnFailure(raw) {
  let data
  try {
    data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  if (data.status === 'aborted') return { status: 'aborted', text: null }
  if (data.status !== 'error') return null
  return { status: 'error', text: lastTurnError(data.transcript_path) }
}

/** Quote text as a Markdown block, line by line, so Cursor's words stand apart from ours. */
function quote(text) {
  return text.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join('\n')
}

/** What the room is told. */
export function turnFailureMessage(failure, agentName) {
  if (failure.status === 'aborted') {
    return `${agentName} was stopped before it finished this. Send your message again if you still need it.`
  }
  const lead = failure.text
    ? `${agentName} couldn't finish this. It said:\n\n${quote(failure.text)}`
    : `${agentName} couldn't finish this. It stopped with an error; its terminal shows what went wrong.`
  return `${lead}\n\nAnything it asks you to do happens in ${agentName} on the computer it's running on. Once that's sorted, send your message again.`
}

/**
 * Answer the room commands a failed turn carries, once, and mark them answered so the
 * stop's request bookkeeping closes them. Returns the command ids answered; none when
 * the turn completed, was typed at the terminal, or was already answered.
 * `post(args)` posts with post_session_message.
 */
export async function postTurnFailure({ raw, connectionId, post, dir, agentName }) {
  const failure = parseTurnFailure(raw)
  if (!failure || !connectionId) return []
  const commands = commandsAnsweredNow(readRequestState(connectionId, { dir }))
  if (commands.length === 0) return []
  await post({
    connection_id: connectionId,
    agent_name: agentName,
    message: turnFailureMessage(failure, agentName),
    complete_turn: true,
  })
  for (const id of commands) appendRequestEvent(connectionId, { op: 'answered', id }, { dir })
  return commands
}
