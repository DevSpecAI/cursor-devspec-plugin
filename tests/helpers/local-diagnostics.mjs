import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diagnosticsRoot, startDiagnostics, stopDiagnostics } from '../../hooks/scripts/local-diagnostics.mjs'
export const ID = '10000000-0000-4000-8000-000000000001'
export const OTHER = '20000000-0000-4000-8000-000000000002'
export async function fixture(fn, enabled = false) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-local-'))
  const home = path.join(parent, 'home')
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CURSOR_CONVERSATION_ID: process.env.CURSOR_CONVERSATION_ID }
  fs.mkdirSync(home)
  process.env.HOME = home; process.env.USERPROFILE = home
  delete process.env.CURSOR_CONVERSATION_ID
  const connections = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connections, { recursive: true })
  const seed = id => fs.writeFileSync(path.join(connections, `${id}.json`), JSON.stringify({ enabled: true, connection_id: id, local_id: id, session_id: id, host_version: '2026.09.18', mcp_token: 'SYMBOLIC_SECRET' }))
  seed(ID)
  const root = diagnosticsRoot()
  const run = enabled ? startDiagnostics(ID) : null
  try { return await fn({ parent, home, root, run, connections, seed, events: () => {
    const file = path.join(run.dir, 'events.jsonl')
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  } }) } finally {
    try { stopDiagnostics(ID) } catch {}
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value
    fs.rmSync(parent, { recursive: true, force: true })
  }
}
