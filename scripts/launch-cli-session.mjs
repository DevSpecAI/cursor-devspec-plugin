#!/usr/bin/env node
/**
 * Interactive Cursor CLI session launcher (runs inside the user's terminal).
 * Mints a chat via `agent create-chat`, stamps local_session_id into the prompt,
 * then starts interactive `agent --resume` with DevSpec flag policy:
 * work → `--force --approve-mcps`; brainstorm → `--plan --approve-mcps`
 * (no `-p` / `--trust` — those are print/headless-only).
 *
 * For remote Connect prompts: runs mechanical fast-connect (register → optional
 * attach → write state, poller deferred) AFTER create-chat and BEFORE --resume,
 * stamps a thin post-Live brief, then starts the poller once `agent --resume`
 * has a durable owner PID in its process tree (item f099fc6e).
 *
 * Invoked by open-handler-core when surface=cli:
 *   node launch-cli-session.mjs --folder <path> --prompt-file <path> [--agent <path>]
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import {
  expandRemoteControlLaunchPrompt,
  promptIsRemoteConnect,
} from './pin-remote-plugin.mjs'
import {
  durationMs,
  emitConnectPhase,
  newLaunchId,
} from '../hooks/scripts/connect-phase-timing.mjs'
import { resolveDevspecMcpAuth } from '../hooks/scripts/resolve-mcp-auth.mjs'
import { fastConnect } from '../hooks/scripts/fast-connect.mjs'
import { ensurePollerAfterAgentSpawn } from '../hooks/scripts/remote-control-state.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--folder' && argv[i + 1]) out.folder = argv[++i]
    else if (a === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i]
    else if (a === '--agent' && argv[i + 1]) out.agent = argv[++i]
    else if (a === '--model' && argv[i + 1]) out.model = argv[++i]
  }
  return out
}

export function stampLine(sessionId) {
  return `DevSpec local_session_id for this run (stamp on record_implementation / failure update): ${sessionId}`
}

/**
 * Correlate launcher + connect Axiom phase rows (item 383de0cd).
 * @param {string} launchId
 * @returns {string}
 */
export function launchIdStampLine(launchId) {
  return `DevSpec launch_id for this run (pass --launch-id on remote-control-state / wait): ${launchId}`
}

/**
 * Full multiline prompt written to disk for the agent to read.
 * Never put this on argv — remote-control embeds (~28KB SKILL.md with YAML
 * `---`) and Windows/PowerShell argv forwarding turns a bare `---` into
 * `error: unknown option '---'` (session aa5090bc / item e949305f).
 * @param {string} expandedBody
 * @param {string} chatId
 * @param {{ launchId?: string | null }} [opts]
 * @returns {string}
 */
export function buildStampedPromptBody(expandedBody, chatId, opts = {}) {
  const stamp = stampLine(chatId)
  const launchStamp =
    typeof opts.launchId === 'string' && opts.launchId.trim()
      ? launchIdStampLine(opts.launchId.trim())
      : null
  const footer = launchStamp ? `${stamp}\n${launchStamp}` : stamp
  const body = typeof expandedBody === 'string' ? expandedBody.trim() : ''
  return body ? `${body}\n\n${footer}\n` : `${footer}\n`
}

/**
 * Path for the stamped prompt file, colocated with the launch prompt.
 * @param {string} promptFile
 * @param {string} chatId
 * @returns {string}
 */
export function resolveStampedPromptPath(promptFile, chatId) {
  const dir = path.dirname(promptFile)
  let base = path.basename(promptFile)
  // Launch files are `*.prompt.txt` — strip that compound suffix so we do not
  // produce `foo.prompt.stamped-….txt`.
  if (base.toLowerCase().endsWith('.prompt.txt')) {
    base = base.slice(0, -'.prompt.txt'.length)
  } else {
    base = path.basename(promptFile, path.extname(promptFile))
  }
  const shortId =
    String(chatId ?? '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 12) || 'chat'
  return path.join(dir, `${base}.stamped-${shortId}.txt`)
}

/**
 * Plugin root when this launcher is running from the installed (or source) tree.
 * @returns {string}
 */
export function pluginRootFromLauncher() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Quote a filesystem path for an agent-facing Shell one-liner (not cmd.exe).
 * @param {string} p
 * @returns {string}
 */
export function quotePathForPrompt(p) {
  const s = String(p ?? '')
  if (!s) return '""'
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/**
 * Exact first Shell command for mechanical Connect (item 1586a9e4).
 * One-shot wait + `--from-end` so queued owner mail is not skipped (1f177af4).
 * @param {{ pluginRoot: string, connectionId: string, launchId?: string | null }} opts
 * @returns {string}
 */
export function buildRemoteWaitCommand(opts) {
  const waitScript = path.join(
    path.resolve(String(opts.pluginRoot ?? '')),
    'hooks',
    'scripts',
    'devspec-remote-wait.mjs',
  )
  const connectionId = String(opts.connectionId ?? '').trim()
  const launchId =
    typeof opts.launchId === 'string' && opts.launchId.trim() ? opts.launchId.trim() : ''
  const parts = [
    'node',
    quotePathForPrompt(waitScript),
    '--connection-id',
    connectionId,
    '--from-end',
  ]
  if (launchId) parts.push('--launch-id', launchId)
  return parts.join(' ')
}

/**
 * Short argv prompt — no skill body, no YAML `---`, safe under Windows
 * CreateProcess / PowerShell forwarding (item e949305f).
 *
 * Non-Connect: pointer to the stamped file.
 * Remote Connect after Live: imperative wait-first command; stamp stays on
 * disk for recovery only (item 1586a9e4).
 * @param {string} stampedPromptPath
 * @param {{ waitFirst?: boolean, waitCommand?: string }} [opts]
 * @returns {string}
 */
export function buildShortArgvPrompt(stampedPromptPath, opts = {}) {
  const p = path.resolve(String(stampedPromptPath ?? ''))
  const waitCommand =
    typeof opts.waitCommand === 'string' && opts.waitCommand.trim()
      ? opts.waitCommand.trim()
      : ''
  if (opts.waitFirst === true && waitCommand) {
    return (
      `Arm wait FIRST with this exact Shell command. Do not read any file, skill, or script before it. ${waitCommand} ` +
      `After it prints owner_message, act only on that. Stamp on disk for recovery only: ${p}`
    )
  }
  return `Read the file at ${p} and follow every instruction in it exactly, then begin.`
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
 * @param {{ approval?: 'force' | 'auto-review', worktree?: boolean, model?: string | null }} [opts]
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
  const model = typeof opts.model === 'string' ? opts.model.trim() : ''
  if (model) {
    flags.push('--model', model)
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

  // A real native .exe (e.g. OpenCode, which ships a compiled binary rather
  // than an npm .cmd/.ps1 shim trio like Cursor's `agent`) needs no shell at
  // all — spawn it directly. Real bug found live-testing: routing a bare
  // .exe through the cmd.exe /c wrapping below added an unnecessary shell
  // hop that a visible console window kept leaking through on regardless of
  // windowsHide, even with stdio:'ignore' set on every spawn call.
  if (lower.endsWith('.exe')) {
    return { command: bin, prefixArgs: [], mode: 'direct' }
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
  if (inv.mode === 'powershell-ps1' || inv.mode === 'direct') {
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
  if (inv.mode === 'powershell-ps1' || inv.mode === 'direct') {
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
      'Usage: launch-cli-session.mjs --folder <path> --prompt-file <path> [--agent <path>] [--model <id>]',
    )
    process.exitCode = 1
    return
  }

  const agentBin = args.agent || 'agent'
  const launchId = newLaunchId()
  const auth = resolveDevspecMcpAuth(args.folder)
  const timingCtx = {
    launch_id: launchId,
    agent: 'Cursor',
    mcpUrl: auth.mcp_url || null,
  }

  let promptBody
  try {
    promptBody = (await fsPromises.readFile(args.promptFile, 'utf8')).trim()
  } catch (err) {
    console.error(`[devspec-cli] could not read prompt file: ${err}`)
    process.exitCode = 1
    return
  }

  console.log(`[devspec-cli] Creating Cursor CLI chat… (launch_id=${launchId})`)
  const createStarted = Date.now()
  const created = spawnAgentSync(agentBin, ['create-chat'], {
    cwd: args.folder,
    encoding: 'utf8',
  })
  await emitConnectPhase({
    ...timingCtx,
    phase: 'create_chat',
    outcome: created.status === 0 ? 'ok' : 'error',
    duration_ms: durationMs(createStarted),
    reason: created.status === 0 ? null : `exit_${created.status || 1}`,
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

  /** @type {{ connection_id: string, session_id?: string | null, codename?: string | null, local_id?: string | null, launch_id?: string | null } | null} */
  let connectResult = null
  const isRemoteConnect = promptIsRemoteConnect(promptBody)

  if (isRemoteConnect) {
    console.log(`[devspec-cli] Mechanical fast-connect (local_id=${chatId})…`)
    const connected = await fastConnect({
      localId: chatId,
      cwd: args.folder,
      launchId,
      promptText: promptBody,
      // Poller needs a durable owner PID. That process does not exist until
      // agent --resume is spawned (item f099fc6e / Restless Owl).
      noPoller: true,
    })
    if (!connected.ok) {
      await emitConnectPhase({
        ...timingCtx,
        phase: 'register_connection',
        outcome: 'error',
        duration_ms: 0,
        local_id: chatId,
        reason: connected.error || 'fast_connect_failed',
      })
      console.error(`[devspec-cli] fast-connect failed: ${connected.error || 'unknown'}`)
      process.exitCode = 1
      return
    }
    connectResult = {
      connection_id: connected.connection_id,
      session_id: connected.session_id,
      codename: connected.codename,
      local_id: connected.local_id || chatId,
      launch_id: connected.launch_id || launchId,
    }
    console.log(
      `[devspec-cli] Live as ${connectResult.codename || connectResult.connection_id.slice(0, 8)}…` +
        (connectResult.session_id ? ` (session ${connectResult.session_id.slice(0, 8)}…)` : ' (sessionless)'),
    )
  }

  // Remote Connect: thin post-Live brief with IDs. Other prompts: pin/expand as before
  // (stop still embeds skill; work/brainstorm unchanged).
  const expandStarted = Date.now()
  const expandedBody =
    expandRemoteControlLaunchPrompt(promptBody, {
      connect: connectResult
        ? {
            connectionId: connectResult.connection_id,
            sessionId: connectResult.session_id,
            codename: connectResult.codename,
            localId: connectResult.local_id,
            launchId: connectResult.launch_id,
          }
        : null,
    }) ?? promptBody
  await emitConnectPhase({
    ...timingCtx,
    phase: isRemoteConnect && connectResult ? 'expand_stamp' : isRemoteConnect ? 'skip_stamp' : 'expand_stamp',
    outcome: 'ok',
    duration_ms: durationMs(expandStarted),
    local_id: chatId,
    connectionId: connectResult?.connection_id || null,
    sessionId: connectResult?.session_id || null,
    extra: {
      stamp_chars: String(expandedBody || '').length,
      thin_brief: !!(isRemoteConnect && connectResult),
    },
  })

  // Write the full expanded+stamped prompt to disk; pass only a short argv
  // pointer. Embedding SKILL.md (with YAML ---) on argv broke Windows launches
  // with `unknown option '---'` (item e949305f).
  const stampedBody = buildStampedPromptBody(expandedBody, chatId, { launchId })
  const stampedPath = resolveStampedPromptPath(args.promptFile, chatId)
  const writeStarted = Date.now()
  try {
    await fsPromises.writeFile(stampedPath, stampedBody, 'utf8')
  } catch (err) {
    await emitConnectPhase({
      ...timingCtx,
      phase: 'write_stamp',
      outcome: 'error',
      duration_ms: durationMs(writeStarted),
      local_id: chatId,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    })
    console.error(`[devspec-cli] could not write stamped prompt file: ${err}`)
    process.exitCode = 1
    return
  }
  await emitConnectPhase({
    ...timingCtx,
    phase: 'write_stamp',
    outcome: 'ok',
    duration_ms: durationMs(writeStarted),
    local_id: chatId,
    connectionId: connectResult?.connection_id || null,
    extra: { stamp_chars: stampedBody.length },
  })
  const argvPrompt = buildShortArgvPrompt(
    stampedPath,
    isRemoteConnect && connectResult?.connection_id
      ? {
          waitFirst: true,
          waitCommand: buildRemoteWaitCommand({
            pluginRoot: pluginRootFromLauncher(),
            connectionId: connectResult.connection_id,
            launchId: connectResult.launch_id || launchId,
          }),
        }
      : {},
  )
  console.log(`[devspec-cli] Stamped prompt → ${stampedPath} (${stampedBody.length} chars; argv ${argvPrompt.length} chars)`)

  const kind = inferCursorAgentRunKindFromPrompt(expandedBody)
  const policyFlags = buildInteractiveCursorAgentFlags(kind, {
    model: args.model ?? null,
  })

  const inv = resolveWindowsAgentInvocation(agentBin)
  console.log(
    `[devspec-cli] Resuming chat ${chatId} in ${args.folder} (kind=${kind} model=${args.model || 'auto'} invoke=${inv.mode})`,
  )
  const spawnStarted = Date.now()
  const child = spawnAgent(
    agentBin,
    ['--resume', chatId, '--workspace', args.folder, ...policyFlags, argvPrompt],
    {
      cwd: args.folder,
      stdio: 'inherit',
      env: {
        ...process.env,
        DEVSPEC_LAUNCH_ID: launchId,
        CURSOR_CONVERSATION_ID: process.env.CURSOR_CONVERSATION_ID || chatId,
      },
    },
  )
  // Spawn itself is synchronous; duration covers resolve + process create.
  await emitConnectPhase({
    ...timingCtx,
    phase: 'agent_resume',
    outcome: 'ok',
    duration_ms: durationMs(spawnStarted),
    local_id: chatId,
    connectionId: connectResult?.connection_id || null,
    sessionId: connectResult?.session_id || null,
    extra: { invoke_mode: inv.mode, chat_id: chatId },
  })

  child.on('error', (err) => {
    console.error(`[devspec-cli] failed to start agent: ${err}`)
    process.exitCode = 1
  })

  if (connectResult?.connection_id && child.pid) {
    const pollerStarted = Date.now()
    const poller = ensurePollerAfterAgentSpawn(connectResult.connection_id, child.pid, {
      cwd: args.folder,
      sessionId: connectResult.session_id || null,
    })
    await emitConnectPhase({
      ...timingCtx,
      phase: 'ensure_poller',
      outcome: poller.ok ? 'ok' : 'error',
      duration_ms: durationMs(pollerStarted),
      local_id: chatId,
      connectionId: connectResult.connection_id,
      sessionId: connectResult.session_id || null,
      reason: poller.ok ? null : poller.error || 'ensure_poller_failed',
      extra: {
        poller_pid: poller.pid || null,
        owner_pid: poller.owner_pid || null,
        deferred_until_resume: true,
        spawn_pid: child.pid,
      },
    })
    if (!poller.ok) {
      console.error(`[devspec-cli] ensure-poller after resume failed: ${poller.error}`)
    } else {
      console.log(
        `[devspec-cli] Poller pid ${poller.pid} anchored to owner ${poller.owner_pid}`,
      )
    }
  }

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
