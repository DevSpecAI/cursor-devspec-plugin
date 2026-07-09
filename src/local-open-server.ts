import * as http from 'http'
import type * as vscode from 'vscode'

/**
 * Fixed localhost port for browser → extension "Open in Cursor" handoff.
 * Cursor treats `cursor://publisher.extension/...` as a marketplace install deeplink
 * for extensions not on Open VSX, so DevSpec uses http://127.0.0.1 instead.
 * Keep in sync with DevSpecV2 `lib/mcp/connect-clients.ts` CURSOR_LOCAL_OPEN_BASE.
 */
export const DEVSPEC_LOCAL_OPEN_PORT = 42731
export const DEVSPEC_LOCAL_OPEN_BASE = `http://127.0.0.1:${DEVSPEC_LOCAL_OPEN_PORT}/open`

export function startLocalOpenServer(
  context: vscode.ExtensionContext,
  openRepo: (slug: string) => Promise<void>,
): void {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method not allowed')
      return
    }

    let pathname = '/'
    let repo: string | null = null
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${DEVSPEC_LOCAL_OPEN_PORT}`)
      pathname = url.pathname
      repo = url.searchParams.get('repo')
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
    if (req.method === 'HEAD') {
      res.writeHead(200)
      res.end()
      return
    }

    void openRepo(slug)
      .then(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          `<!DOCTYPE html><html><head><title>DevSpec</title></head><body><p>Opening <strong>${escapeHtml(slug)}</strong> in Cursor. You can close this tab.</p></body></html>`,
        )
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Failed to open repository')
      })
  })

  server.listen(DEVSPEC_LOCAL_OPEN_PORT, '127.0.0.1', () => {
    // Bound — ready for DevSpec rocket-button requests.
  })

  context.subscriptions.push({
    dispose: () => {
      server.close()
    },
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
