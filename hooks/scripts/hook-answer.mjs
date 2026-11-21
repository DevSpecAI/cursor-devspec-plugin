/**
 * Every plugin hook answers Cursor (item 6ddde907; the preToolUse hook learned it first,
 * item 46dd5fc4).
 *
 * cursor-agent logs a command hook that prints nothing as failed (`errorClass:
 * empty_stdout`), so a hook with nothing to say put hundreds of failures a session into
 * Cursor's own hook log. Cursor reads `{}` as an answer that asks for nothing (every
 * field of every step's answer is optional), and logs the run as a success.
 *
 * `answerCursorAtExit()`, called first thing when a script runs as a hook, keeps that
 * true on every path out, early `process.exit(0)`s included: if the hook printed no
 * answer of its own, `{}` is written as the process exits.
 */
import fs from 'node:fs'

/** What a hook with nothing to say prints. */
export const NOTHING_TO_SAY = '{}'

let installed = false

/**
 * Answer `{}` at exit unless this process printed an answer of its own. Call it only
 * when the script runs as a hook, never in a mode a person or the model reads. Written
 * synchronously, since an exit handler cannot wait for a pending write.
 */
export function answerCursorAtExit({ stdout = process.stdout, fd = 1, onExit = (fn) => process.once('exit', fn) } = {}) {
  if (installed) return
  installed = true
  let answered = false
  const write = stdout.write.bind(stdout)
  stdout.write = (chunk, ...rest) => {
    if (!answered && chunk != null && String(chunk).trim() !== '') answered = true
    return write(chunk, ...rest)
  }
  onExit(() => {
    if (answered) return
    try {
      fs.writeSync(fd, NOTHING_TO_SAY)
    } catch {
      /* Cursor closed our stdout: there is nobody left to answer */
    }
  })
}
