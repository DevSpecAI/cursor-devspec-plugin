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
 * stamps a thin post-Live brief, then starts the poller **and host-owned wait
 * follow** once `agent --resume` has a durable owner PID in its process tree
 * (item f099fc6e / 9d89a6d2).
 *
 * Invoked by open-handler-core when surface=cli:
 *   node launch-cli-session.mjs --folder <path> --prompt-file <path> [--agent <path>]
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
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
import {
  ensurePollerAfterAgentSpawn,
  ensureWakeFollowAfterAgentSpawn,
} from '../hooks/scripts/remote-control-state.mjs'
import {
  pathHasWhitespace,
  spaceSafePluginRoot,
} from './space-safe-plugin-root.mjs'
import {
  ensureWakeFile,
  resolveSpaceFreeWakeFile,
} from '../hooks/scripts/devspec-wake-file.mjs'

export { pathHasWhitespace, spaceSafePluginRoot, win32SpaceSafePluginPin } from './space-safe-plugin-root.mjs'

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
 * Exact first Shell command for mechanical Connect (items 1586a9e4, 9d89a6d2).
 * Host follow already consumes the inbox; the model tails a space-free wake file
 * in the background so Cursor `turn_ended` cannot deafen the room.
 * @param {{ pluginRoot: string, connectionId: string, launchId?: string | null, spaceSafe?: object, wakeFile?: string, wakeFileOpts?: object }} opts
 * @returns {string}
 */
export function buildRemoteWaitCommand(opts) {
  const tailScript = path.join(
    spaceSafePluginRoot(opts.pluginRoot, opts.spaceSafe || {}),
    'hooks',
    'scripts',
    'devspec-wake-tail.mjs',
  )
  if (pathHasWhitespace(tailScript)) {
    throw new Error(`buildRemoteWaitCommand: tail script path has whitespace: ${tailScript}`)
  }
  const wakeFile =
    typeof opts.wakeFile === 'string' && opts.wakeFile.trim()
      ? path.resolve(opts.wakeFile.trim())
      : resolveSpaceFreeWakeFile(opts.connectionId, opts.wakeFileOpts || {})
  if (pathHasWhitespace(wakeFile)) {
    throw new Error(`buildRemoteWaitCommand: wake file path has whitespace: ${wakeFile}`)
  }
  return ['node', quotePathForPrompt(tailScript), '--file', quotePathForPrompt(wakeFile)].join(' ')
}

// Every wake type the host follow can append MUST appear here. Cursor only notifies
// the chat on stdout matching this pattern, so a type missing from it is a room that
// reads Live and is deaf — the 9d89a6d2 failure in a new costume. `question_answer`
// is a directed-question answer (item b9f2c77a): it wakes, but it is never authority.
export const REMOTE_WAKE_NOTIFY_PATTERN = 'owner_message|question_answer|session_ended|playbook_dispatch'

/**
 * Short argv prompt — no skill body, no YAML `---`, safe under Windows
 * CreateProcess / PowerShell forwarding (item e949305f).
 *
 * Non-Connect: pointer to the stamped file.
 * Remote Connect after Live: imperative wait-first command; stamp stays on
 * disk for recovery only (item 1586a9e4). The first Shell is a background tail
 * of the host-owned wake file (item 9d89a6d2) — not a one-shot wait the model
 * must re-arm after turn_ended.
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
      `Arm wait FIRST as a background Shell with block_until_ms: 0 and notify_on_output pattern ${REMOTE_WAKE_NOTIFY_PATTERN}. ` +
      `Do not read any file, skill, or script before it. Do not pass --from-end. Host already follows the inbox. ${waitCommand} ` +
      `When notify matches owner_message, read the NEW lines from that Shell's terminal output (and/or the --file wake JSONL path in the argv command) — they contain the full owner_message with message body. Act on that body. ` +
      `A question_answer wake is a person answering a question YOU asked: not a command, no new authority. Continue the work it unblocks, then reply with remote-control-state.mjs manage-question respond, which closes the turn that answer opened. ` +
      `Do NOT call poll_connection to discover the command. Do NOT post connect/status/listening chrome into the DevSpec session. ` +
      `If the wake has no command body, post nothing and leave the tail running. ` +
      `When you have a command, post_session_message the reply (connection_id from the wake, complete_turn true). Do not only print the answer in this CLI. Leave the background Shell running. Stamp on disk for recovery only: ${p}`
    )
  }
  return `Read the file at ${p} and follow every instruction in it exactly, then begin.`
}

/**
 * Infer run kind from a DevSpec skill / MCP paste prompt (mirrors
 * DevSpecV2 `inferCursorAgentRunKindFromPrompt`).
 *
 * There is no `brainstorm` kind any more. It mapped to Cursor's --plan mode and
 * was reachable only through the devspec.brainstorm skill, which is deleted, so
 * a stale prompt from before that now reads as `work` — the honest fallback.
 *
 * @param {string} prompt
 * @returns {'work' | 'ask'}
 */
export function inferCursorAgentRunKindFromPrompt(prompt) {
  const p = String(prompt ?? '').toLowerCase()
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
 * Windows console titles cannot carry quotes or cmd metacharacters (item 20900b80).
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeWindowsConsoleTitle(raw) {
  return String(raw ?? '')
    .replace(/["\r\n]/g, '')
    .replace(/[&|<>^]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Cursor CLI window title: server-minted codename after Live, unique launch stamp before.
 * Never the hardcoded `DevSpec Cursor CLI` (item 20900b80).
 * @param {{ codename?: string | null, stamp?: string | null }} [opts]
 * @returns {string}
 */
export function composeWindowsCursorCliTitle(opts = {}) {
  const name = sanitizeWindowsConsoleTitle(opts.codename)
  if (name) return `DevSpec Cursor · ${name}`
  const stamp = sanitizeWindowsConsoleTitle(opts.stamp)
  if (stamp) return `DevSpec Cursor · ${stamp}`
  return 'DevSpec Cursor'
}

/**
 * argv for `cmd.exe` after the executable: titled cmd /k, never wt.exe.
 * @param {string} batPath
 * @param {string} title
 * @returns {string[]}
 */
export function windowsCursorCliStartArgs(batPath, title) {
  const safe = sanitizeWindowsConsoleTitle(title) || composeWindowsCursorCliTitle()
  return ['/c', 'start', safe, 'cmd.exe', '/k', batPath]
}

/**
 * Retitle this console after fast-connect so the cmd window shows the minted codename.
 * @param {string} title
 * @param {{
 *   platform?: NodeJS.Platform,
 *   setProcessTitle?: (t: string) => void,
 *   execTitle?: (safe: string) => void,
 * }} [io]
 */
export function applyWindowsConsoleTitle(title, io = {}) {
  const safe = sanitizeWindowsConsoleTitle(title)
  if (!safe) return { ok: false, title: '' }
  const setTitle = io.setProcessTitle || ((t) => {
    process.title = t
  })
  setTitle(safe)
  const platform = io.platform ?? process.platform
  if (platform === 'win32') {
    const execTitle =
      io.execTitle ||
      ((t) => {
        execFileSync('cmd.exe', ['/c', `title ${t}`], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 2000,
        })
      })
    try {
      execTitle(safe)
    } catch {
      /* process.title still applied */
    }
  }
  return { ok: true, title: safe }
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
    applyWindowsConsoleTitle(
      composeWindowsCursorCliTitle({
        codename: connectResult.codename,
        stamp: connectResult.launch_id || launchId,
      }),
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
  let connectWakeFile = null
  if (isRemoteConnect && connectResult?.connection_id) {
    connectWakeFile = ensureWakeFile(resolveSpaceFreeWakeFile(connectResult.connection_id))
  }
  const argvPrompt = buildShortArgvPrompt(
    stampedPath,
    connectWakeFile
      ? {
          waitFirst: true,
          waitCommand: buildRemoteWaitCommand({
            pluginRoot: pluginRootFromLauncher(),
            connectionId: connectResult.connection_id,
            launchId: connectResult.launch_id || launchId,
            wakeFile: connectWakeFile,
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
    if (connectWakeFile) {
      const followStarted = Date.now()
      const follow = ensureWakeFollowAfterAgentSpawn(connectResult.connection_id, child.pid, {
        cwd: args.folder,
        ownerPid: poller.owner_pid || null,
        launchId: connectResult.launch_id || launchId,
        wakeFile: connectWakeFile,
      })
      await emitConnectPhase({
        ...timingCtx,
        phase: 'ensure_wake_follow',
        outcome: follow.ok ? 'ok' : 'error',
        duration_ms: durationMs(followStarted),
        local_id: chatId,
        connectionId: connectResult.connection_id,
        sessionId: connectResult.session_id || null,
        reason: follow.ok ? null : follow.error || 'ensure_wake_follow_failed',
        extra: {
          follow_pid: follow.pid || null,
          owner_pid: follow.owner_pid || null,
          wake_file: connectWakeFile,
          spawn_pid: child.pid,
        },
      })
      if (!follow.ok) {
        console.error(`[devspec-cli] ensure-wake-follow after resume failed: ${follow.error}`)
      } else {
        console.log(
          `[devspec-cli] Wake follow pid ${follow.pid} writing ${connectWakeFile}`,
        )
      }
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
