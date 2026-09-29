#!/usr/bin/env node
/** Cursor's host-specific prerequisite stays here, outside the shared payload. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { resolveDevspecMcpAuth } from '../hooks/scripts/resolve-mcp-auth.mjs'
import { ensureSpaceSafePluginPin } from './space-safe-plugin-root.mjs'
import { setupFromPlugin } from '../launcher/plugin-setup.mjs'
export async function setupCursorLauncher() {
  if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1') return { ok: false, outcome: 'disabled' }
  const root = fileURLToPath(new URL('../', import.meta.url))
  try {
    ensureSpaceSafePluginPin(root)
    const auth = resolveDevspecMcpAuth()
    return await setupFromPlugin({ cursorRoot: root, account: auth.ok && auth.token && auth.mcp_url ? {
      fingerprint: createHash('sha256').update(auth.token).digest('hex'),
      endpoint: auth.mcp_url,
      verifyAccount: async publicKey => {
        const response = await fetch(new URL('/api/launcher/pair', auth.mcp_url), { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error('Local launcher account pairing failed')
        return response.json()
      },
    } : undefined })
  } catch { return { ok: false, outcome: 'failed', error: 'cursor_setup_failed' } }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await setupCursorLauncher()
  if (!result.ok && !['disabled', 'busy'].includes(result.outcome)) console.error('DevSpec local launching is unavailable. Copy commands remain available.')
  process.exitCode = 0
}
