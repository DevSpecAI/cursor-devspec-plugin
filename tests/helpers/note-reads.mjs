/**
 * Tool calls that read a DevSpec note, the way Cursor reports them to a postToolUse
 * hook: what the agent ran and what came back. For tests only.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** The note id a pointer names (`cat ~/.devspec/notes/<id>.md`). */
export function noteIdIn(text) {
  return /cat ~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(String(text))?.[1] ?? null
}

/** Every part file of note `id`, in order. */
export function noteFiles(home, id) {
  const dir = path.join(home, '.devspec', 'notes')
  const files = [path.join(dir, `${id}.md`)]
  for (let part = 2; fs.existsSync(path.join(dir, `${id}.${part}.md`)); part += 1) files.push(path.join(dir, `${id}.${part}.md`))
  return files
}

/**
 * The shell call `cat <file>` as the agent would make it (`~` form by default), with
 * the output the shell really gave: the command is run, with HOME set to `home`.
 */
export function catCall(home, file, { conversation = 'one', tilde = true } = {}) {
  const shown = tilde ? file.replace(home, '~') : file
  const output = execFileSync('sh', ['-c', `cat ${shown}`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' })
  return {
    conversation_id: conversation,
    tool_name: 'Shell',
    tool_input: { command: `cat ${shown}` },
    tool_output: JSON.stringify({ output, exitCode: 0 }),
  }
}

/** Cursor's Read tool on `file`, reporting the length it read, as Cursor does. */
export function readCall(file, { conversation = 'one', contentLength = fs.readFileSync(file, 'utf8').length } = {}) {
  return {
    conversation_id: conversation,
    tool_name: 'Read',
    tool_input: { file_path: file },
    tool_output: JSON.stringify({ file_path: file, content_length: contentLength }),
  }
}
