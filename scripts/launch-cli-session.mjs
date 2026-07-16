#!/usr/bin/env node
/**
 * Interactive Cursor CLI session launcher (runs inside the user's terminal).
 * Mints a chat via `agent create-chat`, stamps local_session_id into the prompt,
 * then starts interactive `agent --resume` with DevSpec flag policy:
 * work → `--force --approve-mcps`; brainstorm → `--plan --approve-mcps`
 * (no `-p` / `--trust` — those are print/headless-only).
 *
 * Invoked by open-handler-core when surface=cli:
 *   node launch-cli-session.mjs --folder <path> --prompt-file <path> [--agent <path>]
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
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
 * Infer run kind from a DevSpec skill / MCP paste prompt (mirrors
 * DevSpecV2 `inferCursorAgentRunKindFromPrompt`).
 * @param {string} prompt
 * @returns {'work' | 'brainstorm' | 'ask'}
 */
export function inferCursorAgentRunKindFromPrompt(prompt) {
  const p = String(prompt ?? '').toLowerCase()
  if (
    p.includes('devspec.brainstorm') ||
    p.includes('brainstorm action item') ||
    p.includes('brainstorm the following action items')
  ) {
    return 'brainstorm'
  }
  if (p.includes('devspec.verify') || /\b--mode\s+ask\b/.test(p)) {
    return 'ask'
  }
  return 'work'
}

/**
 * Interactive (non-print) Cursor Agent flags for DevSpec rocket launches.
 * Keep in sync with DevSpecV2 `buildCursorAgentFlags` (headless=false).
 * @param {'work' | 'brainstorm' | 'ask' | 'resume'} kind
 * @param {{ approval?: 'force' | 'auto-review', worktree?: boolean }} [opts]
 * @returns {string[]}
 */
export function buildInteractiveCursorAgentFlags(kind, opts = {}) {
  const flags = []
  if (kind === 'brainstorm') {
    flags.push('--plan')
  } else if (kind === 'ask') {
    flags.push('--mode', 'ask')
  } else {
    flags.push(opts.approval === 'auto-review' ? '--auto-review' : '--force')
  }
  flags.push('--approve-mcps')
  if (opts.worktree) flags.push('--worktree')
  return flags
}

/**
 * Quote a single Windows command-line argument for `cmd.exe /s /c`.
 * @param {string} value
 * @returns {string}
 */
export function quoteWinCmdArg(value) {
  const s = String(value)
  if (s.length === 0) return '""'
  if (!/[\s"&<>|^()]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * @deprecated Prefer resolveWindowsAgentInvocation + spawnAgent*.
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
 * Resolve how to invoke the Cursor agent CLI without `shell: true` / nested `cmd /c`.
 *
 * On Windows, `agent.cmd` re-enters PowerShell; wrapping that in `cmd /c` loses a real
 * console TTY, so the interactive agent exits immediately and Windows Terminal
 * flash-closes. Prefer `powershell.exe -File <sibling>.ps1` with a normal argv array.
 *
 * @param {string} agentBin
 * @param {{ existsSync?: (p: string) => boolean }} [io]
 * @returns {{ command: string, prefixArgs: string[], mode: 'powershell-ps1' | 'direct' | 'cmd-fallback' }}
 */
export function resolveWindowsAgentInvocation(agentBin, io = { existsSync: fs.existsSync }) {
  const bin = String(agentBin ?? '').trim() || 'agent'
  if (process.platform !== 'win32') {
    return { command: bin, prefixArgs: [], mode: 'direct' }
  }

  const lower = bin.toLowerCase()
  /** @type {string[]} */
  const ps1Candidates = []
  if (lower.endsWith('.ps1')) {
    ps1Candidates.push(bin)
  } else if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    ps1Candidates.push(bin.replace(/\.(cmd|bat)$/i, '.ps1'))
    // agent.cmd and cursor-agent.cmd both ship a matching .ps1 beside them.
    const dir = path.dirname(bin)
    const base = path.basename(bin, path.extname(bin))
    ps1Candidates.push(path.join(dir, `${base}.ps1`))
    if (base.toLowerCase() === 'agent') {
      ps1Candidates.push(path.join(dir, 'cursor-agent.ps1'))
    }
  }

  for (const candidate of ps1Candidates) {
    if (candidate && io.existsSync(candidate)) {
      return {
        command: process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : 'powershell.exe',
        prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', candidate],
        mode: 'powershell-ps1',
      }
    }
  }

  // Bare `agent` on PATH — let cmd resolve it (no absolute spaced path).
  if (!/[\\/]/.test(bin) && !/\.(cmd|bat|ps1|exe)$/i.test(bin)) {
    return { command: bin, prefixArgs: [], mode: 'cmd-fallback' }
  }

  return { command: bin, prefixArgs: [], mode: 'cmd-fallback' }
}

/**
 * Flatten multiline prompts for argv safety (newlines break `cmd /c` command lines).
 * @param {string} text
 * @returns {string}
 */
export function flattenPromptForArgv(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trim()
}

/**
 * @param {string} agentBin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} opts
 */
export function spawnAgentSync(agentBin, args, opts) {
  const inv = resolveWindowsAgentInvocation(agentBin)
  if (inv.mode === 'powershell-ps1' || (process.platform !== 'win32' && inv.mode === 'direct')) {
    return spawnSync(inv.command, [...inv.prefixArgs, ...args], {
      ...opts,
      shell: false,
      windowsHide: true,
    })
  }
  if (process.platform !== 'win32') {
    return spawnSync(agentBin, args, { ...opts, shell: false })
  }
  // Fallback for absolute .cmd without a sibling .ps1: keep the quoted cmd /c path.
  const cmdLine = [quoteWinCmdArg(agentBin), ...args.map(quoteWinCmdArg)].join(' ')
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
  const inv = resolveWindowsAgentInvocation(agentBin)
  if (inv.mode === 'powershell-ps1' || (process.platform !== 'win32' && inv.mode === 'direct')) {
    return spawn(inv.command, [...inv.prefixArgs, ...args], {
      ...opts,
      shell: false,
    })
  }
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
    promptBody = (await fsPromises.readFile(args.promptFile, 'utf8')).trim()
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

  const stamped = flattenPromptForArgv(
    promptBody ? `${promptBody}\n\n${stampLine(chatId)}` : stampLine(chatId),
  )

  const kind = inferCursorAgentRunKindFromPrompt(promptBody)
  const policyFlags = buildInteractiveCursorAgentFlags(kind)

  const inv = resolveWindowsAgentInvocation(agentBin)
  console.log(
    `[devspec-cli] Resuming chat ${chatId} in ${args.folder} (kind=${kind} invoke=${inv.mode})`,
  )
  const child = spawnAgent(
    agentBin,
    ['--resume', chatId, '--workspace', args.folder, ...policyFlags, stamped],
    {
      cwd: args.folder,
      stdio: 'inherit',
    },
  )

  child.on('error', (err) => {
    console.error(`[devspec-cli] failed to start agent: ${err}`)
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
  (process.argv[1].endsWith('launch-cli-session.mjs') ||
    process.argv[1].endsWith('launch-cli-session.js'))

if (isDirectRun) {
  void main()
}
