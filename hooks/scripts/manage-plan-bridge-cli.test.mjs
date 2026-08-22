import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./remote-control-state.mjs', import.meta.url))
const PROJECT = '11111111-1111-4111-8111-111111111111'
const SESSION_A = '22222222-2222-4222-8222-222222222222'
const SESSION_B = '33333333-3333-4333-8333-333333333333'
const CONNECTION_A = '44444444-4444-4444-8444-444444444444'
const CONNECTION_B = '55555555-5555-4555-8555-555555555555'

function resultPayload(id, value, meta = undefined) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      ...(meta ? { _meta: meta } : {}),
    },
  })
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim())
}

describe('manual Cursor manage-plan CLI lifecycle', () => {
  let home
  let server
  let url
  const registrations = new Map()
  const connectionByLocal = new Map()
  const manageHeaders = []
  let manageCalls = 0

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-manual-plan-e2e-'))
    server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/log') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      const rpc = JSON.parse(body || '{}')
      const name = rpc.params?.name
      const args = rpc.params?.arguments ?? {}
      if (name === 'register_connection') {
        const localId = args.local_id
        const ordinal = (registrations.get(localId) ?? 0) + 1
        registrations.set(localId, ordinal)
        if (!connectionByLocal.has(localId)) {
          connectionByLocal.set(localId, connectionByLocal.size === 0 ? CONNECTION_A : CONNECTION_B)
        }
        const connectionId = connectionByLocal.get(localId)
        const capability = `dvsc_${connectionId === CONNECTION_A ? 'a' : 'b'}_rotation_${ordinal}`
        res.end(resultPayload(rpc.id, {
          connection_id: connectionId,
          created: ordinal === 1,
          connection_capability_version: 1,
        }, {
          devspec: { connection_capability: { version: 1, value: capability } },
        }))
        return
      }
      if (name === 'attach_connection') {
        res.end(resultPayload(rpc.id, {
          connection_id: args.connection_id,
          session_id: args.session_id,
          reattached: false,
        }))
        return
      }
      if (name === 'manage_plan') {
        manageCalls++
        manageHeaders.push(req.headers['x-devspec-connection-capability'] ?? null)
        res.end(resultPayload(rpc.id, {
          action: args.action,
          plan: { id: '66666666-6666-4666-8666-666666666666', revision: 4 },
        }))
        return
      }
      res.statusCode = 400
      res.end(JSON.stringify({ error: `unexpected tool ${name}` }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    url = `http://127.0.0.1:${address.port}/api/mcp`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })

  function cli(args, { input = null } = {}) {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DEVSPEC_MCP_TOKEN: 'dvs_e2e_token',
      DEVSPEC_MCP_URL: url,
    }
    for (const key of [
      'DEVSPEC_REMOTE_LOCAL_ID', 'CURSOR_CONVERSATION_ID', 'CODEX_THREAD_ID',
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'GROK_SESSION_ID',
      'GROK_CONVERSATION_ID',
    ]) delete env[key]
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { env, cwd: home })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      if (input !== null) child.stdin.end(input)
      else child.stdin.end()
    })
  }

  async function mintAndConnect(sessionId) {
    const minted = await cli(['mint-local-id'])
    assert.equal(minted.code, 0, minted.stderr)
    const localId = parseJson(minted.stdout).local_id
    assert.match(localId, /^[0-9a-f-]{36}$/i)

    const registered = await cli([
      'register', '--local-id', localId, '--project-id', PROJECT, '--cwd', home,
    ])
    assert.equal(registered.code, 0, registered.stderr)
    const connectionId = parseJson(registered.stdout).connection_id

    const attached = await cli([
      'attach', '--connection-id', connectionId, '--session', sessionId, '--cwd', home,
    ])
    assert.equal(attached.code, 0, attached.stderr)

    const written = await cli([
      'write', '--connection-id', connectionId, '--session', sessionId,
      '--local-id', localId, '--cwd', home, '--no-poller',
    ])
    assert.equal(written.code, 0, written.stderr)
    return { localId, connectionId }
  }

  it('mints a manual bond, rotates capability, uses it without env identity, refuses siblings, and cleans up', async () => {
    const first = await mintAndConnect(SESSION_A)
    assert.equal(first.connectionId, CONNECTION_A)
    const capabilityPathA = path.join(
      home, '.devspec', 'remote-control', 'connections', `${CONNECTION_A}.capability.json`,
    )
    assert.equal(fs.statSync(capabilityPathA).mode & 0o777, 0o600)
    assert.match(fs.readFileSync(capabilityPathA, 'utf8'), /dvsc_a_rotation_1/)

    // Same manual bond re-registers and rotates. The raw value remains file-only.
    const rotated = await cli([
      'register', '--local-id', first.localId, '--project-id', PROJECT, '--cwd', home,
    ])
    assert.equal(rotated.code, 0, rotated.stderr)
    assert.doesNotMatch(rotated.stdout, /dvsc_/)
    const rotatedDisk = fs.readFileSync(capabilityPathA, 'utf8')
    assert.doesNotMatch(rotatedDisk, /rotation_1/)
    assert.match(rotatedDisk, /dvsc_a_rotation_2/)

    // No CURSOR_CONVERSATION_ID and no model-supplied local/connection/capability id.
    const managed = await cli(['manage-plan', 'use'], {
      input: JSON.stringify({ action: 'advance', expected_revision: 3 }),
    })
    assert.equal(managed.code, 0, managed.stderr)
    assert.equal(parseJson(managed.stdout).result.plan.revision, 4)
    assert.deepEqual(manageHeaders, ['dvsc_a_rotation_2'])

    const sibling = await mintAndConnect(SESSION_B)
    assert.equal(sibling.connectionId, CONNECTION_B)
    const callsBeforeAmbiguous = manageCalls
    const ambiguous = await cli([
      'manage-plan', 'use',
      // Deliberately supplied model-side selectors are ignored; siblings stay ambiguous.
      '--local-id', first.localId, '--connection-id', CONNECTION_A,
    ], {
      input: JSON.stringify({ action: 'list' }),
    })
    assert.equal(ambiguous.code, 1)
    assert.match(parseJson(ambiguous.stdout).error, /ambiguous.*sibling/i)
    assert.equal(manageCalls, callsBeforeAmbiguous, 'ambiguity must fail before MCP')

    const stopSibling = await cli(['disable', '--connection-id', CONNECTION_B])
    assert.equal(stopSibling.code, 0, stopSibling.stderr)
    assert.equal(fs.existsSync(path.join(
      home, '.devspec', 'remote-control', 'connections', `${CONNECTION_B}.capability.json`,
    )), false)

    // Removing the sibling restores the one exact minted host-index candidate.
    const resumed = await cli(['manage-plan', 'use'], {
      input: JSON.stringify({ action: 'get' }),
    })
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.deepEqual(manageHeaders, ['dvsc_a_rotation_2', 'dvsc_a_rotation_2'])

    const stopFirst = await cli(['disable', '--connection-id', CONNECTION_A])
    assert.equal(stopFirst.code, 0, stopFirst.stderr)
    assert.equal(fs.existsSync(capabilityPathA), false)
    const afterCleanup = await cli(['manage-plan', 'use'], {
      input: JSON.stringify({ action: 'list' }),
    })
    assert.equal(afterCleanup.code, 1)
    assert.match(parseJson(afterCleanup.stdout).error, /no unambiguous live attached plan bond/i)
  })
})
