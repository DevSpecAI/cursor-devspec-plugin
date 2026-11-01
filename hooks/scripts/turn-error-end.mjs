#!/usr/bin/env node
/**
 * Did Cursor end this turn with an error? (item 45eb0708)
 *
 * When Cursor stops a turn on its own side (usage limit, provider error), no
 * end-of-turn hook runs and the model never posts a reply, so the poller would keep
 * asserting Working until the no-sign-of-life backstop (turn-liveness.mjs, 1 hour).
 * Cursor does record the failure as the LAST line of the bonded agent transcript:
 *
 *   {"type":"turn_ended","status":"error","error":"You've hit your usage limit ..."}
 *
 * The line carries no timestamp, so "is it for THIS turn" is decided by position and
 * file time: a later turn appends below it (it stops being the last line), and a turn
 * that has not written anything yet has a transcript older than its own marker.
 */
import fs from 'node:fs'

/**
 * The whole turn_ended line is a few hundred bytes, but the lines above it can be
 * enormous (tool results). Reading a fixed tail is a cost bound on a file that can
 * grow without limit, not a cut of any text we deliver: a tail that does not hold
 * one complete final line is simply "no errored end seen".
 */
const TAIL_BYTES = 16 * 1024

/**
 * @param {{ transcriptPath: string | null, startedAt: number }} input
 * @returns {{ error: string } | null}
 */
export function erroredTurnEnd({ transcriptPath, startedAt }) {
  if (!transcriptPath || typeof startedAt !== 'number') return null
  let fd = null
  try {
    fd = fs.openSync(transcriptPath, 'r')
    const { size, mtimeMs } = fs.fstatSync(fd)
    if (size === 0 || mtimeMs < startedAt) return null
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim())
    const last = lines[lines.length - 1]
    if (!last || (size > length && lines.length < 2)) return null
    const row = JSON.parse(last)
    if (row?.type !== 'turn_ended' || row.status !== 'error') return null
    return { error: typeof row.error === 'string' && row.error.trim() ? row.error.trim() : '' }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing to release */
      }
    }
  }
}

/** The room message for an errored end: what happened, in Cursor's words, and what to do. */
export function erroredTurnNotice({ error }) {
  const why = error ? ` Cursor said: "${error}"` : ''
  return `Cursor stopped before it could finish your message.${why}\n\nOnce Cursor is available again, send your message again.`
}
