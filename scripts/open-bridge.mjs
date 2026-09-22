#!/usr/bin/env node
/**
 * macOS-only localhost bridge fallback for DevSpec "Open in Cursor".
 * Windows/Linux use the devspec:// protocol handler instead.
 *
 * Unsigned requests are accepted here (CORS-restricted) because macOS cannot
 * register a bare script as a protocol handler without a signed .app bundle.
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import { renderOpenSuccess, renderMissingMapping } from './open-bridge-pages.mjs'
import { verifyHandoffToken } from './handoff-verify.mjs'
import { recipeFromHandoffPayload } from './fleet-recipe.mjs'
import {
  DEVSPEC_LOCAL_OPEN_PORT,
  DEVSPEC_DIR,
  ensureDevspecDir,
  executeHandoff,
} from './open-handler-core.mjs'

const PID_PATH = `${DEVSPEC_DIR}/open-bridge.pid`

export function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false
  return (
    // The web app, where "Open in Cursor" is clicked.
    origin === 'https://app.devspec.ai' ||
    origin === 'https://app.devspecstaging.com' ||
    // Legacy hosts, kept until they are retired.
    origin === 'https://devspec.ai' ||
    origin === 'https://staging.devspec.ai' ||
    origin.endsWith('.devspec.ai') ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:')
  )
}

export function applyCors(req, res) {
  const origin = req.headers.origin
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  // Chrome's Private Network Access: a request from a public HTTPS page to a
  // loopback address is preflighted, and the preflight must opt in explicitly
  // or the fetch fails before it reaches us. Without this, /health cannot be
  // used from the app to tell "launcher present" from "launcher missing" —
  // which is the difference between a useful message and a silent no-op.
  // Only offered to origins we already allow above.
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
}

async function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function startMacOsBridgeServer() {
  if (process.platform !== 'darwin') return

  try {
    const existingPid = Number(await fs.readFile(PID_PATH, 'utf8'))
    if (existingPid && (await isProcessAlive(existingPid))) {
      console.log(`[devspec-open-bridge] already running (pid ${existingPid})`)
      return
    }
  } catch {
    // no pid file
  }

  const server = http.createServer((req, res) => {
    applyCors(req, res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method not allowed')
      return
    }

    let pathname = '/'
    let repo = null
    let prompt = null
    let itemTitle = null
    let token = null
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${DEVSPEC_LOCAL_OPEN_PORT}`)
      pathname = url.pathname
      repo = url.searchParams.get('repo')
      prompt = url.searchParams.get('prompt')
      itemTitle = url.searchParams.get('title')
      token = url.searchParams.get('t')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad request')
      return
    }

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, mode: 'macos_bridge', port: DEVSPEC_LOCAL_OPEN_PORT }))
      return
    }

    if (pathname !== '/open') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    if (!repo && !token) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing repo or token query parameter')
      return
    }

    let slug
    let promptText
    let displayTitle
    /** @type {'ide' | 'cli'} */
    let surface = 'ide'
    /** @type {'cursor' | 'opencode' | 'pi'} */
    let tool = 'cursor'
    /** @type {string | null} */
    let model = null
    /** @type {'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null} */
    let thinking = null
    /** @type {Record<string, number> | null} */
    let recipe = null

    if (token) {
      const verified = verifyHandoffToken(decodeURIComponent(token))
      if (!verified.ok) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Invalid or expired handoff token')
        return
      }
      slug = verified.data.repo
      promptText = verified.data.prompt ?? null
      displayTitle = verified.data.title ?? null
      surface = verified.data.surface === 'cli' ? 'cli' : 'ide'
      tool = verified.data.tool === 'opencode' || verified.data.tool === 'pi'
        ? verified.data.tool
        : 'cursor'
      model = verified.data.model ?? null
      thinking = verified.data.thinking ?? null
      recipe = recipeFromHandoffPayload(verified.data)
    } else {
      slug = decodeURIComponent(repo)
      promptText = prompt ? decodeURIComponent(prompt) : null
      displayTitle = itemTitle ? decodeURIComponent(itemTitle) : null
      surface = 'ide'
    }

    if (req.method === 'HEAD') {
      res.writeHead(200)
      res.end()
      return
    }

    void executeHandoff({
      slug,
      promptText,
      itemTitle: displayTitle,
      surface,
      tool,
      model,
      thinking,
      recipe,
      requireSignedToken: false,
      unsigned: true,
    })
      .then((result) => {
        if (!result.ok && result.error === 'missing_mapping') {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderMissingMapping(slug))
          return
        }
        if (!result.ok) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Failed to open repository')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          renderOpenSuccess({
            slug,
            itemTitle: displayTitle?.trim() || null,
            hasPrompt: Boolean(promptText?.trim()),
          }),
        )
      })
      .catch((err) => {
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
      `[devspec-open-bridge] macOS fallback listening on http://127.0.0.1:${DEVSPEC_LOCAL_OPEN_PORT}/open (pid ${process.pid})`,
    )
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('[devspec-open-bridge] HTTP bridge is macOS-only. Use open-handler.mjs --install on Windows/Linux.')
    process.exitCode = 1
    return
  }
  await startMacOsBridgeServer()
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  void main()
}
