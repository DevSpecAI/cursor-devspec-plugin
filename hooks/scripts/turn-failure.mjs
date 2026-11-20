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
 *
 * A turn the room saw working that carries no such command (a check job, an
 * automation run, a prompt typed at the terminal, or a command that was answered before
 * Cursor stopped) is told the same words as a room message of its own (`notice`, item
 * 45eb0708): otherwise Working would clear with no explanation. It is posted to the room
 * by `session_id`, without `connection_id`, which `post_session_message` documents as a
 * post tied to no turn: it joins no command's turn and answers nothing (DevSpec
 * 59acf1bfe). A connection post would join the connection's current turn, or, with none
 * open, be bound to the last command's attempt even after that was answered, and the
 * assistant-speech lane is annotated with the open turn and quotes the current command.
 */

import { appendRequestEvent, commandsAnsweredNow, readRequestState } from './requests.mjs'
import { fitRoomMessage } from './room-message.mjs'
import { lastTurnEnd } from './transcript-turn-end.mjs'

/**
 * Cursor's own error text for the turn that just ended, or null: the transcript's last
 * turn end (transcript-turn-end.mjs), when it is an error.
 */
export function lastTurnError(transcriptPath) {
  const end = lastTurnEnd(transcriptPath)
  return end?.status === 'error' ? end.error : null
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

/**
 * The room message for a failed turn that answers no command: by `session_id` alone, so
 * DevSpec ties it to no turn (see the header).
 */
export function turnFailureNotice({ sessionId, agentName, message }) {
  return { session_id: sessionId, agent_name: agentName, message, turn_kind: 'agent', phase: 'answer' }
}

/**
 * Tell the room about a failed turn in a message of its own, answering nothing: for a
 * turn end that cannot be tied to the room command beyond doubt (transcript-turn-end.mjs).
 * `post(args)` posts with post_session_message.
 */
export async function postTurnNotice({ failure, sessionId, agentName, post }) {
  if (!failure || !sessionId) return false
  await post(turnFailureNotice({ sessionId, agentName, message: failureRoomMessage(failure, agentName) }))
  return true
}

/** The failure in the room's words, quoted whole up to the room's own limit, then cut visibly. */
function failureRoomMessage(failure, agentName) {
  return fitRoomMessage(turnFailureMessage(failure, agentName), {
    whereRest: `The full error is in ${agentName}'s terminal.`,
  })
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
 * turn end's request bookkeeping closes them. Returns the command ids answered; none
 * when the turn completed, carried no unanswered command, or was already answered.
 * With `notice` and the room's `sessionId`, a failed turn that carries no unanswered
 * command is told to the room in a message of its own (turnFailureNotice). The failure is the stop hook's input (`raw`), or one
 * the caller already read from the transcript (`failure`, as parseTurnFailure returns
 * it: the poller, when Cursor runs no stop hook, transcript-turn-end.mjs). `post(args)`
 * posts with post_session_message.
 */
export async function postTurnFailure({
  raw = null,
  failure: given = undefined,
  connectionId,
  sessionId = null,
  post,
  dir,
  agentName,
  notice = false,
}) {
  const failure = given === undefined ? parseTurnFailure(raw) : given
  if (!failure || !connectionId) return []
  const commands = commandsAnsweredNow(readRequestState(connectionId, { dir }))
  const message = failureRoomMessage(failure, agentName)
  if (commands.length === 0) {
    if (notice && sessionId) await post(turnFailureNotice({ sessionId, agentName, message }))
    return []
  }
  await post({
    connection_id: connectionId,
    agent_name: agentName,
    message,
    complete_turn: true,
  })
  for (const id of commands) appendRequestEvent(connectionId, { op: 'answered', id }, { dir })
  return commands
}
