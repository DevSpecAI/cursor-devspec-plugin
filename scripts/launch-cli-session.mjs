#!/usr/bin/env node
/**
 * Interactive Cursor CLI session launcher (runs inside the user's terminal).
 * Mints a chat via `agent create-chat`, stamps local_session_id into the prompt,
 * then starts interactive `agent --resume` (no -p / --force — rocket is human-in-the-loop).
 *
 * Invoked by open-handler-core when surface=cli:
 *   node launch-cli-session.mjs --folder <path> --prompt-file <path> [--agent <path>]
 */
import fs from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--folder' && argv[i + 1]) out.folder = argv[++i]
    else if (a === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i]
    else if (a === '--agent' && argv[i + 1]) out.agent = argv[++i]
  }
  return out
}

function stampLine(sessionId) {
  return `DevSpec local_session_id for this run (stamp on record_implementation / failure update): ${sessionId}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.folder || !args.promptFile) {
    console.error(
      'Usage: launch-cli-session.mjs --folder <path> --prompt-file <path> [--agent <path>]',
    )
    process.exitCode = 1
    return
  }

  const agentBin = args.agent || 'agent'
  let promptBody
  try {
    promptBody = (await fs.readFile(args.promptFile, 'utf8')).trim()
  } catch (err) {
    console.error(`[devspec-cli] could not read prompt file: ${err}`)
    process.exitCode = 1
    return
  }

  console.log('[devspec-cli] Creating Cursor CLI chat…')
  const created = spawnSync(agentBin, ['create-chat'], {
    cwd: args.folder,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (created.status !== 0) {
    console.error(
      `[devspec-cli] agent create-chat failed (exit ${created.status}): ${created.stderr || created.stdout || ''}`,
    )
    process.exitCode = created.status || 1
    return
  }

  const chatId = String(created.stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  if (!chatId) {
    console.error('[devspec-cli] agent create-chat returned no chat id')
    process.exitCode = 1
    return
  }

  const stamped = promptBody
    ? `${promptBody}\n\n${stampLine(chatId)}`
    : stampLine(chatId)

  console.log(`[devspec-cli] Resuming chat ${chatId} in ${args.folder}`)
  const child = spawn(
    agentBin,
    [
      '--resume',
      chatId,
      '--workspace',
      args.folder,
      '--approve-mcps',
      '--trust',
      stamped,
    ],
    {
      cwd: args.folder,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  )

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exitCode = 1
      return
    }
    process.exitCode = code ?? 0
  })
}

void main()
