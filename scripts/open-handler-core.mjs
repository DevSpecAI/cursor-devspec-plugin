/**
 * Shared DevSpec "Open in Cursor" handoff logic.
 * Used by the devspec:// protocol handler and the macOS localhost bridge fallback.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { verifyHandoffToken } from './handoff-verify.mjs'
import { quoteWinCmdArg } from './launch-cli-session.mjs'
import { expandRemoteControlLaunchPrompt } from './pin-remote-plugin.mjs'

const execFileAsync = promisify(execFile)

/**
 * Build a Windows `.cmd` body that runs node + launch args (cmd-style quoting).
 * @param {string} nodeBin
 * @param {string[]} launchArgs
 * @param {string} folderPath
 * @returns {string}
 */
export function buildWindowsCliLaunchBat(nodeBin, launchArgs, folderPath) {
  const cdLine = `cd /d ${quoteWinCmdArg(folderPath)}`
  const runLine = [nodeBin, ...launchArgs].map(quoteWinCmdArg).join(' ')
  return `@echo off\r\n${cdLine}\r\n${runLine}\r\n`
}

/**
 * @deprecated Prefer writing buildWindowsCliLaunchBat to a .cmd and starting it.
 * Kept for unit coverage of title/cmdline composition.
 * @param {string} nodeBin
 * @param {string[]} launchArgs
 * @param {string} [title]
 * @returns {string}
 */
export function buildWindowsCliStartCommand(nodeBin, launchArgs, title = 'DevSpec Cursor CLI') {
  const safeTitle = String(title).replace(/"/g, '')
  const cmdline = [nodeBin, ...launchArgs].map(quoteWinCmdArg).join(' ')
  return `start "${safeTitle}" cmd.exe /k ${cmdline}`
}

export const DEVSPEC_PROTOCOL_SCHEME = 'devspec'
export const DEVSPEC_OPEN_PATH = '/open'
/** macOS fallback only — keep in sync with DevSpecV2 CURSOR_LOCAL_OPEN_BASE. */
export const DEVSPEC_LOCAL_OPEN_PORT = 42731
export const DEVSPEC_DIR = path.join(os.homedir(), '.cursor', 'devspec')
export const MAP_PATH = path.join(DEVSPEC_DIR, 'repo-folder-map.json')
export const HANDLER_LOG_PATH = path.join(DEVSPEC_DIR, 'handler.log')

export async function ensureDevspecDir() {
  await fs.mkdir(DEVSPEC_DIR, { recursive: true })
}

export async function appendHandlerLog(line) {
  try {
    await ensureDevspecDir()
    await fs.appendFile(HANDLER_LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // ignore
  }
}

async function readMap() {
  try {
    const raw = await fs.readFile(MAP_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {}
    throw err
  }
}

async function writeMap(map) {
  await ensureDevspecDir()
  await fs.writeFile(MAP_PATH, JSON.stringify(map, null, 2), 'utf8')
}

function parseGitHubSlug(remoteUrl) {
  const match = String(remoteUrl).trim().match(/github\.com[:/]([^/\s]+)\/([^/\s#?.]+)/i)
  if (!match?.[1] || !match[2]) return null
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`
}

async function pathExists(folderPath) {
  try {
    await fs.access(folderPath)
    return true
  } catch {
    return false
  }
}

async function gitRemoteSlug(folderPath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', folderPath, 'remote', 'get-url', 'origin'], {
      timeout: 5000,
    })
    return parseGitHubSlug(stdout)
  } catch {
    return null
  }
}

async function discoverRepoFolder(slug) {
  const [owner, name] = slug.split('/')
  if (!owner || !name) return null

  const home = os.homedir()
  const candidates = [
    path.join(home, 'Repositories', owner, name),
    path.join(home, 'Repositories', 'Combined', name),
    path.join(home, 'repos', owner, name),
    path.join(home, 'repos', name),
    path.join(home, 'Projects', owner, name),
    path.join(home, 'Projects', name),
    path.join(home, 'Developer', owner, name),
    path.join(home, 'Developer', name),
    path.join(home, 'src', owner, name),
    path.join(home, 'src', name),
    path.join(home, name),
  ]

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue
    const remoteSlug = await gitRemoteSlug(candidate)
    if (remoteSlug === slug) return candidate
  }

  const searchRoots = [
    path.join(home, 'Repositories'),
    path.join(home, 'repos'),
    path.join(home, 'Projects'),
    path.join(home, 'Developer'),
  ]

  for (const root of searchRoots) {
    if (!(await pathExists(root))) continue
    const hit = await walkForSlug(root, slug, 0, 4)
    if (hit) return hit
  }

  return null
}

async function walkForSlug(dir, slug, depth, maxDepth) {
  if (depth > maxDepth) return null
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    const remoteSlug = await gitRemoteSlug(full)
    if (remoteSlug === slug) return full
    const nested = await walkForSlug(full, slug, depth + 1, maxDepth)
    if (nested) return nested
  }
  return null
}

function resolveCursorExecutable() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe')
  }
  return 'cursor'
}

/**
 * Resolve the Cursor Agent CLI binary (`agent`). Prefer PATH, then known install dirs.
 * @returns {Promise<string | null>}
 */
export async function resolveAgentExecutable() {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(whichCmd, ['agent'], { timeout: 5000 })
    const first = String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (first && (await pathExists(first))) return first
  } catch {
    // fall through to known paths
  }

  const home = os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(home, 'AppData', 'Local', 'cursor-agent', 'agent.exe'),
          path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app', 'bin', 'agent.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'agent.exe'),
        ]
      : [
          path.join(home, '.local', 'bin', 'agent'),
          '/usr/local/bin/agent',
          path.join(home, '.cursor', 'bin', 'agent'),
        ]

  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) return candidate
  }
  return null
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Resolve the OpenCode CLI binary (`opencode`). Prefer PATH, then known install dirs.
 * Mirrors resolveAgentExecutable's where/which + known-path fallback pattern.
 * @returns {Promise<string | null>}
 */
export async function resolveOpencodeExecutable() {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(whichCmd, ['opencode'], { timeout: 5000 })
    const lines = String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    // Real bug found live-testing: on Windows, `where opencode` can list a
    // bare extensionless file ahead of the real .cmd/.ps1 shim — npm always
    // generates that extensionless one as a POSIX `#!/bin/sh` script for
    // Git-Bash/WSL, which cmd.exe/PowerShell cannot execute at all. Taking
    // the first line unconditionally resolved to that unusable shim, and
    // the whole connect attempt failed completely silently (stdio was
    // 'ignore' the entire way up the spawn chain, so nothing surfaced).
    // Prefer a genuinely Windows-executable match when one exists.
    const preferred =
      process.platform === 'win32'
        ? lines.find((l) => /\.(cmd|exe|bat|ps1)$/i.test(l)) ?? lines[0]
        : lines[0]
    if (preferred && (await pathExists(preferred))) return preferred
  } catch {
    // fall through to known paths
  }

  const home = os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.APPDATA ?? '', 'npm', 'opencode.cmd'),
          path.join(home, 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
        ]
      : [
          path.join(home, '.local', 'bin', 'opencode'),
          '/usr/local/bin/opencode',
          path.join(home, '.opencode', 'bin', 'opencode'),
        ]

  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) return candidate
  }
  return null
}

/**
 * Open an OS terminal that runs launch-cli-session.mjs (interactive agent).
 * @param {{ folderPath: string, promptText: string | null, agentBin: string, model?: string | null }} opts
 */
export async function openInAgentCli({ folderPath, promptText, agentBin, model }) {
  await ensureDevspecDir()
  const launchesDir = path.join(DEVSPEC_DIR, 'launches')
  await fs.mkdir(launchesDir, { recursive: true })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const promptFile = path.join(launchesDir, `${stamp}.prompt.txt`)
  await fs.writeFile(promptFile, promptText?.trim() ? `${promptText.trim()}\n` : '', 'utf8')

  // Prefer the installed copy under ~/.cursor/devspec; fall back to sibling of this module.
  const installedLauncher = path.join(DEVSPEC_DIR, 'launch-cli-session.mjs')
  const siblingLauncher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launch-cli-session.mjs')
  const launcher = (await pathExists(installedLauncher)) ? installedLauncher : siblingLauncher

  const nodeBin = process.execPath
  const launchArgs = [
    launcher,
    '--folder',
    folderPath,
    '--prompt-file',
    promptFile,
    '--agent',
    agentBin,
  ]
  const modelId = typeof model === 'string' ? model.trim() : ''
  if (modelId) {
    launchArgs.push('--model', modelId)
  }

  if (process.platform === 'win32') {
    // Always open a titled cmd.exe /k window. Do NOT use
    // %LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe — that path is an App Execution
    // Alias: fs.access succeeds, but spawn fails silently (stat is EACCES / 0-byte
    // stub). The protocol handler then logs success while the user only sees the
    // brief handler console flash.
    //
    // Write a .cmd launcher and `start` that file. Putting the full quoted node
    // command into one spawn argv makes Node's Windows quoter emit bash-style
    // `\"…\"`, and cmd fails with `'\"C:\…\node.exe\"' is not recognized`.
    const batPath = path.join(launchesDir, `${stamp}.launch.cmd`)
    await fs.writeFile(batPath, buildWindowsCliLaunchBat(nodeBin, launchArgs, folderPath), 'utf8')
    spawn('cmd.exe', ['/c', 'start', 'DevSpec Cursor CLI', 'cmd.exe', '/k', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: folderPath,
    }).unref()
    return
  }

  if (process.platform === 'darwin') {
    const cmd = `cd ${shellSingleQuote(folderPath)} && ${shellSingleQuote(nodeBin)} ${launchArgs
      .map(shellSingleQuote)
      .join(' ')}`
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${shellSingleQuote(cmd)}`], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  // Linux — try common terminal emulators.
  const linuxCmd = `${shellSingleQuote(nodeBin)} ${launchArgs.map(shellSingleQuote).join(' ')}`
  const terminals = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', linuxCmd]],
    ['gnome-terminal', ['--', 'bash', '-lc', linuxCmd]],
    ['konsole', ['-e', 'bash', '-lc', linuxCmd]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(linuxCmd)}`]],
  ]
  for (const [bin, args] of terminals) {
    try {
      await execFileAsync('which', [bin], { timeout: 2000 })
      spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
        cwd: folderPath,
      }).unref()
      return
    } catch {
      // try next
    }
  }
  throw new Error('No terminal emulator found to launch Cursor CLI')
}

/**
 * OpenCode session launches — production intent is headless (item 63662a98).
 *
 * `false` → production headless: hidden spawn, no console flash. DevSpec's live
 * work trail (and needs-your-input) is the visibility surface for remote turns.
 * `true`  → TEMP DEBUG: open a real console and pass `--headed` so serve/client
 *           windows are visible. Flip back to `false` when finished debugging.
 *
 * Escape hatch: pass `--headed` to launch-opencode-session.mjs directly.
 *
 * TEMP (item 3dd5467c, owner request 2026-08-10): headed again while live-testing
 * the Working trail / remote-control path. Production default remains headless —
 * set this back to `false` when that testing is done.
 */
export const OPENCODE_LAUNCH_HEADED = true

/**
 * Launch OpenCode via launch-opencode-session.mjs.
 *
 * When `OPENCODE_LAUNCH_HEADED` is true, opens a visible terminal (TEMP DEBUG).
 * Flip the flag back to false for normal remote use.
 * @param {{ folderPath: string, promptText: string | null, opencodeBin: string, model?: string | null }} opts
 */
export async function openInOpenCode({ folderPath, promptText, opencodeBin, model }) {
  await ensureDevspecDir()
  const launchesDir = path.join(DEVSPEC_DIR, 'launches')
  await fs.mkdir(launchesDir, { recursive: true })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const promptFile = path.join(launchesDir, `${stamp}.prompt.txt`)
  await fs.writeFile(promptFile, promptText?.trim() ? `${promptText.trim()}\n` : '', 'utf8')

  // Prefer the installed copy under ~/.cursor/devspec; fall back to sibling of this module.
  const installedLauncher = path.join(DEVSPEC_DIR, 'launch-opencode-session.mjs')
  const siblingLauncher = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'launch-opencode-session.mjs',
  )
  const launcher = (await pathExists(installedLauncher)) ? installedLauncher : siblingLauncher

  const nodeBin = process.execPath
  const launchArgs = [launcher, '--folder', folderPath, '--prompt-file', promptFile, '--opencode', opencodeBin]
  const modelId = typeof model === 'string' ? model.trim() : ''
  if (modelId) {
    launchArgs.push('--model', modelId)
  }
  if (OPENCODE_LAUNCH_HEADED) {
    launchArgs.push('--headed')
  }

  // Headed: reuse Cursor CLI's visible-terminal path so the user can watch the
  // launcher. Headless: keep the production hidden spawn (no console flash).
  if (OPENCODE_LAUNCH_HEADED) {
    if (process.platform === 'win32') {
      const batPath = path.join(launchesDir, `${stamp}.opencode-launch.cmd`)
      await fs.writeFile(batPath, buildWindowsCliLaunchBat(nodeBin, launchArgs, folderPath), 'utf8')
      spawn('cmd.exe', ['/c', 'start', 'DevSpec OpenCode', 'cmd.exe', '/k', batPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: folderPath,
      }).unref()
      return
    }

    if (process.platform === 'darwin') {
      const cmd = `cd ${shellSingleQuote(folderPath)} && ${shellSingleQuote(nodeBin)} ${launchArgs
        .map(shellSingleQuote)
        .join(' ')}`
      spawn('osascript', ['-e', `tell application "Terminal" to do script ${shellSingleQuote(cmd)}`], {
        detached: true,
        stdio: 'ignore',
      }).unref()
      return
    }

    const linuxCmd = `${shellSingleQuote(nodeBin)} ${launchArgs.map(shellSingleQuote).join(' ')}`
    const terminals = [
      ['x-terminal-emulator', ['-e', 'bash', '-lc', linuxCmd]],
      ['gnome-terminal', ['--', 'bash', '-lc', linuxCmd]],
      ['konsole', ['-e', 'bash', '-lc', linuxCmd]],
      ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(linuxCmd)}`]],
    ]
    for (const [bin, args] of terminals) {
      try {
        await execFileAsync('which', [bin], { timeout: 2000 })
        spawn(bin, args, {
          detached: true,
          stdio: 'ignore',
          cwd: folderPath,
        }).unref()
        return
      } catch {
        // try next
      }
    }
    throw new Error('No terminal emulator found to launch OpenCode headed')
  }

  spawn(nodeBin, launchArgs, {
    cwd: folderPath,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  }).unref()
}

const CURSOR_PROMPT_DEEPLINK_BASE = 'cursor://anysphere.cursor-deeplink/prompt'
const CURSOR_PROMPT_DEEPLINK_MAX = 8000
const PROMPT_DEEPLINK_DELAY_MS = 1500

function buildCursorPromptDeeplink(text) {
  const trimmed =
    text.length > CURSOR_PROMPT_DEEPLINK_MAX ? text.slice(0, CURSOR_PROMPT_DEEPLINK_MAX) : text
  return `${CURSOR_PROMPT_DEEPLINK_BASE}?text=${encodeURIComponent(trimmed)}`
}

function openCursorDeeplink(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

function openExternalUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

function openErrorPage(slug, reason) {
  const base = process.env.DEVSPEC_API_URL?.replace(/\/+$/, '') || 'https://devspec.ai'
  const params = new URLSearchParams({ repo: slug, reason })
  openExternalUrl(`${base}/cursor-handoff/error?${params}`)
}

export function scheduleAgentPrompt(promptText) {
  if (!promptText?.trim()) return
  const deeplink = buildCursorPromptDeeplink(promptText.trim())
  setTimeout(() => openCursorDeeplink(deeplink), PROMPT_DEEPLINK_DELAY_MS)
}

export async function openInCursor(folderPath) {
  const cursorExe = resolveCursorExecutable()
  if (process.platform === 'win32' && !(await pathExists(cursorExe))) {
    throw new Error(`Cursor executable not found at ${cursorExe}`)
  }

  const child = spawn(cursorExe, [folderPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

export async function resolveRepoFolder(slug) {
  const map = await readMap()
  const stored = map[slug]
  if (stored && (await pathExists(stored))) return stored

  const discovered = await discoverRepoFolder(slug)
  if (discovered) {
    map[slug] = discovered
    await writeMap(map)
    return discovered
  }

  return null
}

/** Normalize OS protocol invocations (devspec:open?x → devspec://open?x). */
export function normalizeProtocolUrl(raw) {
  let value = String(raw ?? '').trim()
  // Windows / Chrome sometimes wrap the URL in quotes when invoking the handler.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  if (!value) return null
  if (value.startsWith('devspec:') && !value.startsWith('devspec://')) {
    value = `devspec://${value.slice('devspec:'.length)}`
  }
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * True when the URL targets the handoff open path.
 *
 * Chrome often rewrites `devspec://open?t=…` to `devspec://open/?t=…`, which
 * the WHATWG URL parser stores as hostname=`open` + pathname=`/`. Older forms
 * use pathname `/open` with an empty host.
 */
export function isHandoffOpenUrl(url) {
  if (!url || url.protocol !== 'devspec:') return false
  const host = (url.hostname || '').toLowerCase()
  const path = url.pathname || ''
  if (host === 'open' && (path === '' || path === '/')) return true
  if ((host === '' || host === 'localhost') && (path === '/open' || path === 'open')) return true
  return false
}

/**
 * Parse devspec://open?repo=…&prompt=…&title=…&token=…
 * Returns null when the URL is not a supported handoff.
 */
export function parseHandoffUrl(raw) {
  const url = normalizeProtocolUrl(raw)
  if (!url || !isHandoffOpenUrl(url)) return null

  const token = url.searchParams.get('t') || url.searchParams.get('token')
  if (token) {
    const verified = verifyHandoffToken(token)
    if (!verified.ok) return { error: verified.error ?? 'invalid_token' }
    return {
      slug: verified.data.repo,
      promptText: verified.data.prompt ?? null,
      itemTitle: verified.data.title ?? null,
      surface: verified.data.surface === 'cli' ? 'cli' : 'ide',
      tool: verified.data.tool === 'opencode' ? 'opencode' : 'cursor',
      model: verified.data.model ?? null,
    }
  }

  const repo = url.searchParams.get('repo')
  if (!repo) return { error: 'missing_repo' }
  const surfaceRaw = url.searchParams.get('surface')
  const toolRaw = url.searchParams.get('tool')
  const modelRaw = url.searchParams.get('model')
  return {
    slug: decodeURIComponent(repo),
    promptText: url.searchParams.get('prompt')
      ? decodeURIComponent(url.searchParams.get('prompt'))
      : null,
    itemTitle: url.searchParams.get('title')
      ? decodeURIComponent(url.searchParams.get('title'))
      : null,
    surface: surfaceRaw === 'cli' ? 'cli' : 'ide',
    tool: toolRaw === 'opencode' ? 'opencode' : 'cursor',
    model: modelRaw ? decodeURIComponent(modelRaw) : null,
    /** Unsigned localhost bridge requests (macOS fallback only). */
    unsigned: true,
  }
}

/**
 * Execute the handoff: open Cursor IDE (default) or spawn interactive Cursor CLI.
 * @returns {{ ok: true } | { ok: false, error: string, slug?: string }}
 */
export async function executeHandoff({
  slug,
  promptText,
  itemTitle,
  surface = 'ide',
  tool = 'cursor',
  model = null,
  requireSignedToken = true,
  unsigned = false,
}) {
  if (requireSignedToken && unsigned) {
    await appendHandlerLog('rejected unsigned handoff')
    return { ok: false, error: 'unsigned_not_allowed', slug }
  }

  const folderPath = await resolveRepoFolder(slug)
  if (!folderPath) {
    await appendHandlerLog(`missing mapping for ${slug}`)
    openErrorPage(slug, 'missing_mapping')
    return { ok: false, error: 'missing_mapping', slug }
  }

  // OpenCode has no separate "ide" surface — it's always a terminal, so it
  // never falls through to the Cursor-app-open branch below regardless of
  // the surface field.
  if (tool === 'opencode') {
    const opencodeBin = await resolveOpencodeExecutable()
    if (!opencodeBin) {
      await appendHandlerLog(`opencode missing for handoff ${slug}`)
      openErrorPage(slug, 'opencode_missing')
      return { ok: false, error: 'opencode_missing', slug }
    }
    try {
      await openInOpenCode({ folderPath, promptText, opencodeBin, model })
      await appendHandlerLog(`opened OpenCode ${slug} → ${folderPath} via ${opencodeBin}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await appendHandlerLog(`OpenCode open failed: ${message}`)
      openErrorPage(slug, 'agent_launch_failed')
      return { ok: false, error: 'agent_launch_failed', slug }
    }
  }

  // Session/web remote-control prompts cannot include a machine-local PLUGIN=
  // path or the Cursor skill body. Expand here so Cursor agents never hunt
  // Claude marketplace caches (item 57d8b288) or mislabel as Claude Code.
  const pinnedPrompt = expandRemoteControlLaunchPrompt(promptText)

  if (surface === 'cli') {
    const agentBin = await resolveAgentExecutable()
    if (!agentBin) {
      await appendHandlerLog(`agent missing for CLI handoff ${slug}`)
      openErrorPage(slug, 'agent_missing')
      return { ok: false, error: 'agent_missing', slug }
    }
    try {
      await openInAgentCli({ folderPath, promptText: pinnedPrompt, agentBin, model })
      await appendHandlerLog(`opened CLI ${slug} → ${folderPath} via ${agentBin}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await appendHandlerLog(`CLI open failed: ${message}`)
      openErrorPage(slug, 'agent_launch_failed')
      return { ok: false, error: 'agent_launch_failed', slug }
    }
  }

  try {
    await openInCursor(folderPath)
    scheduleAgentPrompt(pinnedPrompt)
    await appendHandlerLog(`opened ${slug} → ${folderPath}`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await appendHandlerLog(`open failed: ${message}`)
    openErrorPage(slug, 'open_failed')
    return { ok: false, error: 'open_failed', slug }
  }
}

export async function handleProtocolUrl(raw, opts = {}) {
  const parsed = parseHandoffUrl(raw)
  if (!parsed) {
    const preview = String(raw ?? '').slice(0, 200)
    await appendHandlerLog(`handoff failed: bad_url raw=${JSON.stringify(preview)}`)
    return { ok: false, error: 'bad_url' }
  }
  if ('error' in parsed && !parsed.slug) return { ok: false, error: parsed.error }
  if (parsed.error && !parsed.slug) return { ok: false, error: parsed.error }

  return executeHandoff({
    slug: parsed.slug,
    promptText: parsed.promptText,
    itemTitle: parsed.itemTitle,
    surface: parsed.surface === 'cli' ? 'cli' : 'ide',
    tool: parsed.tool === 'opencode' ? 'opencode' : 'cursor',
    model: parsed.model ?? null,
    unsigned: parsed.unsigned,
    requireSignedToken: opts.requireSignedToken ?? process.platform !== 'darwin',
  })
}
