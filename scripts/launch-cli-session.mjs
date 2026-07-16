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

/**
 * Quote a single Windows command-line argument for `cmd.exe /s /c`.
 * Doubles embedded quotes per Windows argv rules for a quoted token.
 *
 * @param {string} value
 * @returns {string}
 */
export function quoteWinCmdArg(value) {
  const s = String(value)
  if (s.length === 0) return '""'
  // Safe unquoted token: no whitespace / cmd metacharacters.
  if (!/[\s"&<>|^()]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * @deprecated Prefer quoteWinCmdArg + spawnAgent*; kept for unit coverage of the
 * quoting rule that fixed spaced agent.cmd paths under shell:true.
 * @param {string} bin
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function resolveShellExecutable(bin, platform = process.platform) {
  const trimmed = String(bin ?? '').trim()
  if (!trimmed) return trimmed
  if (platform !== 'win32') return trimmed
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
  }
  if (!/[\s&<>|^()"]/.test(trimmed)) return trimmed
  return `"${trimmed.replace(/"/g, '')}"`
}

/**
 * Spawn the Cursor agent CLI. On Windows, invoke via `cmd.exe /d /s /c` with the
 * entire command wrapped in an extra pair of quotes — required so absolute paths
 * containing spaces (e.g. `C:\Users\Brandon Young\...\agent.cmd`) and `.cmd`
 * shims resolve correctly without Node's `shell: true` (which splits unquoted
 * paths and triggers DEP0190).
 *
 * @param {string} agentBin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} opts
 */
export function spawnAgentSync(agentBin, args, opts) {
  if (process.platform !== 'win32') {
    return spawnSync(agentBin, args, { ...opts, shell: false })
  }
  const cmdLine = [quoteWinCmdArg(agentBin), ...args.map(quoteWinCmdArg)].join(' ')
  // Extra outer quotes: cmd's /s /c rule for commands whose first token is quoted
  // and contains spaces (without them, cmd splits at the first space).
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
    ...opts,
    windowsVerbatimArguments: true,
  })
}

/**
 * @param {string} agentBin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} opts
 */
export function spawnAgent(agentBin, args, opts) {
  if (process.platform !== 'win32') {
    return spawn(agentBin, args, { ...opts, shell: false })
  }
  const cmdLine = [quoteWinCmdArg(agentBin), ...args.map(quoteWinCmdArg)].join(' ')
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
    ...opts,
    windowsVerbatimArguments: true,
  })
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
  const created = spawnAgentSync(agentBin, ['create-chat'], {
    cwd: args.folder,
    encoding: 'utf8',
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
  const child = spawnAgent(
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

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('launch-cli-session.mjs') ||
    process.argv[1].endsWith('launch-cli-session.js'))

if (isDirectRun) {
  void main()
}
