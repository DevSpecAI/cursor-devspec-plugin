#!/usr/bin/env node
/**
 * Standalone DevSpec "Open in Cursor" bridge.
 * Cursor Glass layout does not load user VSIX extensions, so the in-extension
 * HTTP server may never start. This process runs outside the extension host.
 *
 * Keep port/path in sync with src/local-open-server.ts and DevSpecV2 connect-clients.
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEVSPEC_LOCAL_OPEN_PORT = 42731
const DEVSPEC_DIR = path.join(os.homedir(), '.cursor', 'devspec')
const MAP_PATH = path.join(DEVSPEC_DIR, 'repo-folder-map.json')
const PID_PATH = path.join(DEVSPEC_DIR, 'open-bridge.pid')

async function ensureDevspecDir() {
  await fs.mkdir(DEVSPEC_DIR, { recursive: true })
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
    const local = path.join(
      process.env.LOCALAPPDATA ?? '',
      'Programs',
      'cursor',
      'Cursor.exe',
    )
    return local
  }
  return 'cursor'
}

/** Cursor official deeplink — pre-fills Agent chat (user confirms before send). */
const CURSOR_PROMPT_DEEPLINK_BASE = 'cursor://anysphere.cursor-deeplink/prompt'
/** Max per https://cursor.com/docs/reference/deeplinks */
const CURSOR_PROMPT_DEEPLINK_MAX = 8000
/** Wait for the folder window to open before pre-filling Agent chat. */
const PROMPT_DEEPLINK_DELAY_MS = 1500

function buildCursorPromptDeeplink(text) {
  const trimmed =
    text.length > CURSOR_PROMPT_DEEPLINK_MAX
      ? text.slice(0, CURSOR_PROMPT_DEEPLINK_MAX)
      : text
  return `${CURSOR_PROMPT_DEEPLINK_BASE}?text=${encodeURIComponent(trimmed)}`
}

function openCursorDeeplink(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

function scheduleAgentPrompt(promptText) {
  if (!promptText?.trim()) return
  const deeplink = buildCursorPromptDeeplink(promptText.trim())
  setTimeout(() => openCursorDeeplink(deeplink), PROMPT_DEEPLINK_DELAY_MS)
}

async function openInCursor(folderPath) {
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

async function resolveRepoFolder(slug) {
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

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function missingMappingHtml(slug) {
  return `<!DOCTYPE html>
<html>
<head><title>DevSpec</title></head>
<body>
  <h1>DevSpec: map local folder for ${escapeHtml(slug)}</h1>
  <p>Cursor is running, but this repo is not mapped yet.</p>
  <ol>
    <li>Open Cursor</li>
    <li>Command Palette → <strong>DevSpec: Manage repo folder mappings</strong></li>
    <li>Or open the repo folder once so DevSpec Autopilot can learn it</li>
    <li>Click the rocket button again</li>
  </ol>
</body>
</html>`
}

async function handleOpen(slug, promptText, res) {
  const folderPath = await resolveRepoFolder(slug)
  if (!folderPath) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(missingMappingHtml(slug))
    return
  }

  await openInCursor(folderPath)
  scheduleAgentPrompt(promptText)
  const promptNote = promptText?.trim()
    ? '<p>Pre-filling Agent chat in Cursor — review the prompt and press Enter to send.</p>'
    : ''
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<!DOCTYPE html><html><head><title>DevSpec</title></head><body><p>Opening <strong>${escapeHtml(slug)}</strong> in Cursor. You can close this tab.</p>${promptNote}</body></html>`,
  )
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method not allowed')
      return
    }

    let pathname = '/'
    let repo = null
    let prompt = null
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${DEVSPEC_LOCAL_OPEN_PORT}`)
      pathname = url.pathname
      repo = url.searchParams.get('repo')
      prompt = url.searchParams.get('prompt')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad request')
      return
    }

    if (pathname !== '/open') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    if (!repo) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing repo query parameter')
      return
    }

    const slug = decodeURIComponent(repo)
    const promptText = prompt ? decodeURIComponent(prompt) : null
    if (req.method === 'HEAD') {
      res.writeHead(200)
      res.end()
      return
    }

    void handleOpen(slug, promptText, res).catch((err) => {
      console.error('[devspec-open-bridge] open failed:', err)
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Failed to open repository')
    })
  })

  server.on('error', (err) => {
    console.error('[devspec-open-bridge] server error:', err)
    process.exit(1)
  })

  server.listen(DEVSPEC_LOCAL_OPEN_PORT, '127.0.0.1', async () => {
    await ensureDevspecDir()
    await fs.writeFile(PID_PATH, String(process.pid), 'utf8')
    console.log(
      `[devspec-open-bridge] listening on http://127.0.0.1:${DEVSPEC_LOCAL_OPEN_PORT}/open (pid ${process.pid})`,
    )
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  if (args.has('--stop')) {
    try {
      const pid = Number(await fs.readFile(PID_PATH, 'utf8'))
      if (pid && (await isProcessAlive(pid))) process.kill(pid)
    } catch {
      // ignore
    }
    try {
      await fs.unlink(PID_PATH)
    } catch {
      // ignore
    }
    return
  }

  try {
    const existingPid = Number(await fs.readFile(PID_PATH, 'utf8'))
    if (existingPid && (await isProcessAlive(existingPid))) {
      if (!args.has('--force')) {
        console.log(`[devspec-open-bridge] already running (pid ${existingPid})`)
        return
      }
      process.kill(existingPid)
    }
  } catch {
    // no pid file
  }

  startServer()
}

void main()
