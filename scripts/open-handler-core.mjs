/**
 * Shared DevSpec "Open in Cursor" handoff logic.
 * Used by the devspec:// protocol handler and the macOS localhost bridge fallback.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyHandoffToken } from './handoff-verify.mjs'

const execFileAsync = promisify(execFile)

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
    }
  }

  const repo = url.searchParams.get('repo')
  if (!repo) return { error: 'missing_repo' }
  return {
    slug: decodeURIComponent(repo),
    promptText: url.searchParams.get('prompt')
      ? decodeURIComponent(url.searchParams.get('prompt'))
      : null,
    itemTitle: url.searchParams.get('title')
      ? decodeURIComponent(url.searchParams.get('title'))
      : null,
    /** Unsigned localhost bridge requests (macOS fallback only). */
    unsigned: true,
  }
}

/**
 * Execute the handoff: open folder in Cursor and pre-fill Agent chat.
 * @returns {{ ok: true } | { ok: false, error: string, slug?: string }}
 */
export async function executeHandoff({ slug, promptText, itemTitle, requireSignedToken = true, unsigned = false }) {
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

  try {
    await openInCursor(folderPath)
    scheduleAgentPrompt(promptText)
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
    unsigned: parsed.unsigned,
    requireSignedToken: opts.requireSignedToken ?? process.platform !== 'darwin',
  })
}
