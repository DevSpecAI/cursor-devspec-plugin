#!/usr/bin/env node
/**
 * OpenCode cold-launch session runner (runs inside the user's terminal).
 * Simpler than launch-cli-session.mjs (Cursor): `opencode run` starts a fresh
 * session itself — no separate create-then-resume dance needed.
 *
 * Invoked by open-handler-core when tool=opencode:
 *   node launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>]
 */
import fsPromises from 'node:fs/promises'
import { spawnAgent } from './launch-cli-session.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--folder' && argv[i + 1]) out.folder = argv[++i]
    else if (a === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i]
    else if (a === '--opencode' && argv[i + 1]) out.opencode = argv[++i]
    else if (a === '--model' && argv[i + 1]) out.model = argv[++i]
  }
  return out
}

/**
 * Build the `opencode run` argv for a prompt body + optional model.
 *
 * `opencode run` does NOT expand a leading "/command args" string the way
 * typing it into the interactive TUI does — passed as a plain positional
 * message, the model just receives it as inert text (observed live: it
 * tried to execute "/devspec.remote --session <uuid>" as a shell path).
 * The registered-command form needs the dedicated --command flag instead,
 * with "--" so yargs doesn't reparse the command's own flags (e.g.
 * --session) as opencode's own.
 * @param {string} promptBody
 * @param {string} [model]
 * @returns {string[]}
 */
export function buildOpencodeRunArgs(promptBody, model) {
  const runArgs = ['run']
  const trimmedModel = typeof model === 'string' ? model.trim() : ''
  if (trimmedModel) runArgs.push('--model', trimmedModel)

  const slashCommand = promptBody.match(/^\/([a-zA-Z0-9_.-]+)\s*(.*)$/s)
  if (slashCommand) {
    const [, commandName, commandArgs] = slashCommand
    runArgs.push('--command', commandName)
    if (commandArgs) runArgs.push('--', commandArgs)
  } else {
    runArgs.push(promptBody)
  }
  return runArgs
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.folder || !args.promptFile) {
    console.error(
      'Usage: launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>]',
    )
    process.exitCode = 1
    return
  }

  const opencodeBin = args.opencode || 'opencode'
  let promptBody
  try {
    promptBody = (await fsPromises.readFile(args.promptFile, 'utf8')).trim()
  } catch (err) {
    console.error(`[devspec-opencode] could not read prompt file: ${err}`)
    process.exitCode = 1
    return
  }

  const runArgs = buildOpencodeRunArgs(promptBody, args.model)

  console.log(
    `[devspec-opencode] Running in ${args.folder} (model=${args.model || 'auto'})`,
  )
  // Reuses the Windows-safe invocation logic built for Cursor's `agent` binary
  // (prefer a sibling .ps1 over wrapping a .cmd in `cmd /c`, which loses the
  // real console TTY and flash-closes the window) — the same shim-resolution
  // problem applies to any npm-installed .cmd binary, not just Cursor's.
  const child = spawnAgent(opencodeBin, runArgs, {
    cwd: args.folder,
    stdio: 'inherit',
  })

  child.on('error', (err) => {
    console.error(`[devspec-opencode] failed to start opencode: ${err}`)
    process.exitCode = 1
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exitCode = 1
      return
    }
    process.exitCode = code ?? 0
  })
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('launch-opencode-session.mjs') ||
    process.argv[1].endsWith('launch-opencode-session.js'))

if (isDirectRun) {
  void main()
}
