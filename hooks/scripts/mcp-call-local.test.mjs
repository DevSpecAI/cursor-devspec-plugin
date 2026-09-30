import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { mcpToolsCall } from './mcp-call.mjs'
import { startDiagnostics, stopDiagnostics, exportDiagnostics } from './local-diagnostics.mjs'
import { fixture, ID } from '../../tests/helpers/local-diagnostics.mjs'
const options = { mcpUrl: 'https://example.invalid/mcp', token: 'SYMBOLIC_TOKEN', name: 'get_action_item', arguments: { connection_id: ID, message: 'SYMBOLIC_PRIVATE' } }
const reply = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }), { status: 200 })

test('enabled MCP timing counts bytes and outcomes without an extra request or changed result', () => fixture(async ({ events }) => {
  const original = globalThis.fetch; let calls = 0
  globalThis.fetch = async (url, init) => { calls++; assert.equal(url, options.mcpUrl); assert.match(init.body, /SYMBOLIC_PRIVATE/); return reply() }
  try {
    assert.deepEqual(await mcpToolsCall(options), { ok: true }); assert.equal(calls, 1)
    const rows = events(); assert.equal(rows.length, 2)
    assert.equal(rows[0].invocationId, rows[1].invocationId)
    assert.equal(rows[1].source, 'plugin_mcp'); assert.equal(rows[1].outcome, 'ok')
    assert.ok(rows[1].request_bytes > 0); assert.ok(rows[1].response_bytes > 0)
    assert.ok(rows[1].duration_ms >= 0); assert.equal(JSON.stringify(rows).includes('SYMBOLIC'), false)
  } finally { globalThis.fetch = original }
}, true))

test('disabled MCP keeps the same single request and makes no diagnostic directory', () => fixture(async ({ root }) => {
  const original = globalThis.fetch; let calls = 0
  globalThis.fetch = async () => { calls++; return reply() }
  try { assert.deepEqual(await mcpToolsCall(options), { ok: true }); assert.equal(calls, 1); assert.equal(fs.existsSync(root), false) }
  finally { globalThis.fetch = original }
}))

test('failed calls preserve the original exception, not its private prose', () => fixture(async ({ events }) => {
  const original = globalThis.fetch, error = new Error('SYMBOLIC_PRIVATE')
  globalThis.fetch = async () => { throw error }
  try { await assert.rejects(mcpToolsCall(options), e => e === error); assert.equal(events()[1].outcome, 'error'); assert.equal(JSON.stringify(events()).includes('SYMBOLIC'), false) }
  finally { globalThis.fetch = original }
}, true))

test('late completion does not retarget a replacement diagnostic run', () => fixture(async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { stopDiagnostics(ID); startDiagnostics(ID); return reply() }
  try {
    await mcpToolsCall(options)
    const exported = JSON.parse(fs.readFileSync(exportDiagnostics(ID), 'utf8'))
    assert.equal(exported.events.length, 0)
  } finally { globalThis.fetch = original }
}, true))
