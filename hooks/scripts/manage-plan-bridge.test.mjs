import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  MANAGE_PLAN_INPUT_SCHEMA,
  buildActiveSessionPlanGuidance,
  clearConnectionCapability,
  describeManagePlanBridge,
  persistConnectionCapability,
  resolveManagePlanBridgeContext,
  useManagePlanBridge,
  validateManagePlanInput,
} from './manage-plan-bridge.mjs'
import {
  FIXTURE_ID,
  fixtureActiveSessionPlans,
} from './remote-ingress-test-fixtures.mjs'

const roots = []
function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-plan-bridge-'))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

function writeBoundState(base, {
  connectionId = FIXTURE_ID.connection,
  localId = 'cursor-chat-a',
  sessionId = 'abababab-abab-4bab-8bab-abababababab',
} = {}) {
  const connections = path.join(base, 'connections')
  const local = path.join(base, 'local', 'cursor')
  fs.mkdirSync(connections, { recursive: true })
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(connections, `${connectionId}.json`), JSON.stringify({
    connection_id: connectionId,
    local_id: localId,
    enabled: true,
    agent_name: 'Cursor',
    cwd: base,
    session_id: sessionId,
  }))
  fs.writeFileSync(path.join(local, `${localId}.json`), JSON.stringify({
    connection_id: connectionId,
    local_id: localId,
    agent_name: 'Cursor',
    session_id: sessionId,
    status: 'live',
  }))
}

describe('Cursor manage_plan describe/use bridge', () => {
  it('describes the complete bounded schema only on demand', () => {
    const described = describeManagePlanBridge()
    assert.equal(described.tool, 'manage_plan')
    assert.deepEqual(described.inputSchema, MANAGE_PLAN_INPUT_SCHEMA)
    assert.deepEqual(described.inputSchema.required, ['action'])
    for (const property of [
      'action', 'plan_id', 'expected_revision', 'title', 'steps', 'step_id',
      'current_step_id', 'next_step_id', 'reason', 'retryable',
    ]) assert.ok(described.inputSchema.properties[property], property)
    assert.equal(described.inputSchema.properties.steps.maxItems, 50)
    assert.doesNotMatch(JSON.stringify(described), /dvsc_/)
    assert.match(described.usage, /stdin/)
  })

  it('rejects model-supplied identity/capability fields', () => {
    assert.match(validateManagePlanInput({ action: 'list', connection_id: FIXTURE_ID.connection }), /identity-bearing/)
    assert.match(validateManagePlanInput({ action: 'list', capability: 'dvsc_secret' }), /identity-bearing/)
    assert.equal(validateManagePlanInput({ action: 'create', title: 'Qualifying work', steps: [{ title: 'Phase one' }] }), null)
    assert.equal(validateManagePlanInput({ action: 'advance', expected_revision: 3 }), null)
    assert.equal(validateManagePlanInput({ action: 'adopt', plan_id: FIXTURE_ID.plan, expected_revision: 3 }), null)
  })

  it('persists mode 0600 and rotates without exposing the raw capability', () => {
    const base = root()
    const first = persistConnectionCapability({
      connectionId: FIXTURE_ID.connection,
      localId: 'cursor-chat-a',
      capability: 'dvsc_first-secret',
    }, { root: base })
    assert.equal(first.ok, true)
    assert.equal(JSON.stringify(first).includes('first-secret'), false)
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600)

    const second = persistConnectionCapability({
      connectionId: FIXTURE_ID.connection,
      localId: 'cursor-chat-a',
      capability: 'dvsc_rotated-secret',
    }, { root: base })
    assert.equal(second.ok, true)
    const disk = fs.readFileSync(second.path, 'utf8')
    assert.doesNotMatch(disk, /first-secret/)
    assert.match(disk, /rotated-secret/)
  })

  it('resolves only the current host conversation bond and rejects sibling mismatch', () => {
    const base = root()
    writeBoundState(base)
    persistConnectionCapability({
      connectionId: FIXTURE_ID.connection,
      localId: 'cursor-chat-a',
      capability: 'dvsc_bound-secret',
    }, { root: base })
    assert.equal(resolveManagePlanBridgeContext({ localId: 'cursor-chat-a' }, { root: base }).ok, true)
    assert.equal(resolveManagePlanBridgeContext({ localId: 'cursor-chat-b' }, { root: base }).ok, false)

    const statePath = path.join(base, 'connections', `${FIXTURE_ID.connection}.json`)
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    fs.writeFileSync(statePath, JSON.stringify({ ...state, session_id: null }))
    assert.match(resolveManagePlanBridgeContext({ localId: 'cursor-chat-a' }, { root: base }).error, /not unambiguously attached/)
    fs.writeFileSync(statePath, JSON.stringify(state))

    const capPath = path.join(base, 'connections', `${FIXTURE_ID.connection}.capability.json`)
    const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'))
    cap.connection_id = FIXTURE_ID.siblingConnection
    fs.writeFileSync(capPath, JSON.stringify(cap))
    assert.equal(resolveManagePlanBridgeContext({ localId: 'cursor-chat-a' }, { root: base }).ok, false)
  })

  it('uses one exact manual host-index bond and refuses ambiguous siblings', () => {
    const base = root()
    writeBoundState(base)
    persistConnectionCapability({
      connectionId: FIXTURE_ID.connection,
      localId: 'cursor-chat-a',
      capability: 'dvsc_bound-secret',
    }, { root: base })
    const manual = resolveManagePlanBridgeContext({ localId: null }, { root: base, cwd: base })
    assert.equal(manual.ok, true)
    assert.equal(manual.source, 'unambiguous_host_bond_index')
    assert.equal(manual.connectionId, FIXTURE_ID.connection)
    assert.match(
      resolveManagePlanBridgeContext({ localId: null }, { root: base, cwd: path.join(base, 'other') }).error,
      /no unambiguous.*workspace/i,
    )

    writeBoundState(base, {
      connectionId: FIXTURE_ID.siblingConnection,
      localId: 'cursor-chat-b',
      sessionId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
    })
    persistConnectionCapability({
      connectionId: FIXTURE_ID.siblingConnection,
      localId: 'cursor-chat-b',
      capability: 'dvsc_sibling-secret',
    }, { root: base })
    const ambiguous = resolveManagePlanBridgeContext({ localId: null }, { root: base, cwd: base })
    assert.equal(ambiguous.ok, false)
    assert.match(ambiguous.error, /ambiguous.*sibling/i)
  })

  it('uses the hidden header for the exact bond and redacts failures', async () => {
    const base = root()
    writeBoundState(base)
    persistConnectionCapability({
      connectionId: FIXTURE_ID.connection,
      localId: 'cursor-chat-a',
      capability: 'dvsc_bound-secret',
    }, { root: base })
    let call
    const used = await useManagePlanBridge(
      { action: 'advance', expected_revision: 3 },
      {
        root: base,
        localId: 'cursor-chat-a',
        resolveAuth: () => ({ ok: true, token: 'dvs_token', mcp_url: 'https://example.test/api/mcp' }),
        mcpCall: async (value) => { call = value; return { plan: { revision: 4 } } },
      },
    )
    assert.equal(used.ok, true)
    assert.equal(call.name, 'manage_plan')
    assert.equal(call.connectionCapability, 'dvsc_bound-secret')
    assert.equal(call.arguments.connection_id, undefined)
    assert.deepEqual(used.result, { plan: { revision: 4 } })
    assert.doesNotMatch(JSON.stringify(used), /bound-secret/)

    const failed = await useManagePlanBridge(
      { action: 'list' },
      {
        root: base,
        localId: 'cursor-chat-a',
        resolveAuth: () => ({ ok: true, token: 'dvs_token', mcp_url: 'https://example.test/api/mcp' }),
        mcpCall: async () => { throw new Error('bad dvsc_bound-secret') },
      },
    )
    assert.equal(failed.ok, false)
    assert.doesNotMatch(failed.error, /bound-secret/)
    assert.match(failed.error, /\[redacted\]/)
  })

  it('clears the capability on exact-connection cleanup only', () => {
    const base = root()
    const saved = persistConnectionCapability({
      connectionId: FIXTURE_ID.connection,
      localId: 'cursor-chat-a',
      capability: 'dvsc_bound-secret',
    }, { root: base })
    assert.equal(fs.existsSync(saved.path), true)
    assert.equal(clearConnectionCapability(FIXTURE_ID.siblingConnection, { root: base }), true)
    assert.equal(fs.existsSync(saved.path), true)
    assert.equal(clearConnectionCapability(FIXTURE_ID.connection, { root: base }), true)
    assert.equal(fs.existsSync(saved.path), false)
  })
})

describe('session plan decision and continuation guidance', () => {
  it('routine no-plan projection adds zero prompt bytes', () => {
    assert.equal(buildActiveSessionPlanGuidance(null, FIXTURE_ID.connection), '')
    assert.equal(buildActiveSessionPlanGuidance({ plans: [] }, FIXTURE_ID.connection), '')
  })

  it('qualifying guidance points WHEN to the contract and prefers atomic advance', () => {
    const described = describeManagePlanBridge()
    assert.match(described.description, /implementation-contract.*decides WHEN/i)
    assert.doesNotMatch(described.description, /complexity|tool count|file count/i)
    const guidance = buildActiveSessionPlanGuidance(fixtureActiveSessionPlans(), FIXTURE_ID.connection)
    assert.match(guidance, /atomic advance/)
    assert.match(guidance, /continue or explicitly close your own active plan/i)
  })

  it('reconnect guidance carries exact plan_id and expected_revision', () => {
    const guidance = buildActiveSessionPlanGuidance(fixtureActiveSessionPlans(), FIXTURE_ID.connection)
    assert.match(guidance, new RegExp(`plan_id=${FIXTURE_ID.plan}`))
    assert.match(guidance, /expected_revision=3/)
    assert.match(guidance, new RegExp(`step_id=${FIXTURE_ID.step}`))
  })

  it('same-owner orphan adoption is explicit while cross-owner plans grant no authority', () => {
    const projection = fixtureActiveSessionPlans()
    projection.plans[0].steward.connection_id = FIXTURE_ID.siblingConnection
    projection.plans[0].orphaned = true
    const guidance = buildActiveSessionPlanGuidance(projection, FIXTURE_ID.connection)
    assert.match(guidance, /Adopt only an orphaned same-owner plan/)
    assert.match(guidance, /another owner’s plan is read-only/i)
    assert.match(guidance, /explicit plan_id is required.*adoption/i)
    assert.match(guidance, /^ROOM /m)
  })
})
