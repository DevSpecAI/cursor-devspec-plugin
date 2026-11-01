#!/usr/bin/env node
/**
 * Mechanical fast-connect (item 1cc2a2d5).
 * Run: node --test hooks/scripts/fast-connect.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectProjectContext } from './project-context.mjs'
import { storeRepositorySnapshot } from './repository-context.mjs'
import { parseArgs } from './remote-control-state.mjs'
let projectHome
beforeEach(() => { projectHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-connect-project-')) })
afterEach(() => fs.rmSync(projectHome, { recursive: true, force: true }))
import {
  fastConnect as connectImpl,
  parseSessionIdFromPrompt,
  resolveProjectForConnect,
} from './fast-connect.mjs'
const fastConnect = opts => connectImpl({ ...opts, projectHome })

describe('parseSessionIdFromPrompt', () => {
  it('parses --session <uuid> and --session=<uuid>', () => {
    const id = '7e3afc79-abf4-48e4-ae33-aed27b00944d'
    assert.equal(
      parseSessionIdFromPrompt(`Run the \`devspec-remote\` skill with this input: --session ${id}`),
      id,
    )
    assert.equal(parseSessionIdFromPrompt(`devspec-remote --session=${id}`), id)
  })

  it('does not take a helper script that shares the skill prefix for the skill', () => {
    const connection = '7e3afc79-abf4-48e4-ae33-aed27b00944d'
    assert.equal(parseSessionIdFromPrompt(`node "$PLUGIN/hooks/scripts/devspec-remote-wait.mjs" --connection-id ${connection} --from-end`), null)
    assert.equal(parseSessionIdFromPrompt(`/devspec-remote-stop ${connection}`), null)
    assert.equal(parseSessionIdFromPrompt(`/devspec-remote ${connection}`), connection)
  })

  it('returns null for non-remote prompts', () => {
    assert.equal(parseSessionIdFromPrompt('Run the `devspec.work` skill'), null)
  })

  it('returns null for automation cold-launch prompts (sessionless register + claim)', () => {
    const projectId = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
    const automationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const runId = '11111111-2222-3333-4444-555555555555'
    const prompt = [
      'DevSpec automation run waiting: "Smoke check"',
      `project_id=${projectId}`,
      `automation_id=${automationId}`,
      `run_id=${runId}`,
      '',
      '1. Register a live connection FIRST. Call register_connection: agent_name="Cursor", cwd=this repo.',
      `2. claim_automation_run({ run_id: "${runId}", provider: "cursor" })`,
    ].join('\n')
    assert.equal(parseSessionIdFromPrompt(prompt), null)
  })

  it('parses session_id= and skips project_id= when scanning bare uuids', () => {
    const projectId = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
    const sessionId = '696a051d-2c2f-45bc-968a-6058b1734193'
    assert.equal(
      parseSessionIdFromPrompt(
        `register_connection then attach_connection({ connection_id: "x", session_id: "${sessionId}" })`,
      ),
      sessionId,
    )
    assert.equal(
      parseSessionIdFromPrompt(
        `project_id=${projectId}\nregister_connection for DevSpec.remote attach`,
      ),
      null,
    )
  })
})

describe('resolveProjectForConnect', () => {
  it('uses explicit project id without MCP', async () => {
    const phases = []
    const r = await resolveProjectForConnect({
      cwd: '/tmp',
      projectId: '11111111-1111-1111-1111-111111111111',
      auth: { ok: true, token: 't', mcp_url: 'https://example.test/api/mcp' },
      launchId: 'launch-1',
      emitPhase: async (p) => {
        phases.push(p)
      },
      mcpCall: async () => {
        throw new Error('should not call')
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.project_id, '11111111-1111-1111-1111-111111111111')
    assert.equal(phases[0].phase, 'project_resolve')
    assert.equal(phases[0].launch_id, 'launch-1')
  })

  it('resolves an explicit exact name without deciding remote precedence', async () => {
    const r = await resolveProjectForConnect({
      cwd: '/tmp',
      gitRemote: 'https://github.com/DevSpecAI/cursor-devspec-plugin.git',
      auth: { ok: true, token: 't', mcp_url: 'https://example.test/api/mcp' },
      launchId: 'launch-2',
      projectId: 'DevSpec',
      emitPhase: async () => {},
      mcpCall: async ({ name, arguments: args }) => {
        assert.equal(name, 'list_projects')
        assert.deepEqual(args, {})
        return {
          projects: [{ id: '24c4abaa-2cb9-496a-8492-cf1f1aa1090b', name: 'DevSpec' }],
          remote_match: { resolved_project_id: '24c4abaa-2cb9-496a-8492-cf1f1aa1090b' },
        }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.project_id, '24c4abaa-2cb9-496a-8492-cf1f1aa1090b')
  })

  it('fails when no accessible project has the explicit name', async () => {
    const r = await resolveProjectForConnect({
      cwd: '/tmp',
      gitRemote: 'https://github.com/example/none.git',
      projectId: 'Missing project',
      auth: { ok: true, token: 't', mcp_url: 'https://example.test/api/mcp' },
      emitPhase: async () => {},
      mcpCall: async () => ({
        projects: [],
        remote_match: { resolved_project_id: null, candidate_project_ids: [] },
      }),
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /No accessible project/)
  })
  it('defers automatic remote and pin resolution to registration without a discovery call', async () => {
    const result = await resolveProjectForConnect({ cwd: '/tmp', gitRemote: 'repo', auth: { ok: true }, mcpCall: async () => { throw new Error('must not discover') } })
    assert.equal(result.ok, true); assert.equal(result.project_id, null); assert.equal(result.source, 'server')
  })
})

describe('fastConnect', () => {
  const connectionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const projectId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  const localId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const launchId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

  it('happy path: register → attach → write → ensure_poller', async () => {
    const phases = []
    const mcpCalls = []
    const r = await fastConnect({
      localId,
      cwd: process.cwd(),
      sessionId,
      launchId,
      projectId,
      resolveAuth: () => ({
        ok: true,
        token: 'test-token',
        mcp_url: 'https://example.test/api/mcp',
        source: 'test',
      }),
      resolveGitRemoteFn: () => 'https://github.com/DevSpecAI/cursor-devspec-plugin.git',
      resolveLocalFn: () => ({
        ok: true,
        action: 'register',
        connection_id: null,
        session_id: null,
      }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      mintLocalIdFn: () => localId,
      emitPhase: async (p) => {
        phases.push(p)
      },
      mcpCall: async () => {
        throw new Error('mcpCall should not be used when register/attach/write are injected')
      },
      registerFn: async (opts) => {
        mcpCalls.push(['register', opts])
        assert.equal(opts.localId, localId)
        assert.equal(opts.projectId, projectId)
        assert.equal(opts.launchId, launchId)
        return {
          ok: true,
          connection_id: connectionId,
          codename: 'Brave Otter',
          project_id: projectId,
          created: true,
        }
      },
      attachFn: async (opts) => {
        mcpCalls.push(['attach', opts])
        assert.equal(opts.connectionId, connectionId)
        assert.equal(opts.sessionId, sessionId)
        return { ok: true, connection_id: connectionId, session_id: sessionId }
      },
      writeFn: async (opts) => {
        mcpCalls.push(['write', opts])
        assert.equal(opts.connectionId, connectionId)
        assert.equal(opts.sessionId, sessionId)
        assert.equal(opts.localId, localId)
        return {
          ok: true,
          connection_id: connectionId,
          session_id: sessionId,
          session_codename: 'Brave Otter',
          mcp_url: 'https://example.test/api/mcp',
          auth_ok: true,
          poller: { ok: true, pid: 4242 },
        }
      },
    })

    assert.equal(r.ok, true)
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, sessionId)
    assert.equal(r.codename, 'Brave Otter')
    assert.equal(r.local_id, localId)
    assert.equal(r.launch_id, launchId)
    assert.deepEqual(
      mcpCalls.map((c) => c[0]),
      ['register', 'attach', 'write'],
    )

    const names = phases.map((p) => p.phase)
    assert.ok(names.includes('resolve_local_id'))
    assert.ok(names.includes('resolve_local'))
    assert.ok(names.includes('ensure_poller'))
    for (const p of phases) {
      assert.equal(p.launch_id, launchId, `phase ${p.phase} missing launch_id`)
      assert.ok(typeof p.duration_ms === 'number')
    }
  })

  it('sessionless: register → write, no attach', async () => {
    const calls = []
    const r = await fastConnect({
      localId,
      launchId,
      projectId,
      resolveAuth: () => ({
        ok: true,
        token: 't',
        mcp_url: 'https://example.test/api/mcp',
      }),
      resolveGitRemoteFn: () => null,
      resolveLocalFn: () => ({ action: 'register', connection_id: null }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async () => {},
      registerFn: async () => {
        calls.push('register')
        return { ok: true, connection_id: connectionId, project_id: projectId, codename: 'Swift Fox' }
      },
      attachFn: async () => {
        calls.push('attach')
        return { ok: true }
      },
      writeFn: async (opts) => {
        calls.push('write')
        assert.equal(opts.sessionId, null)
        return {
          ok: true,
          connection_id: connectionId,
          session_id: null,
          session_codename: 'Swift Fox',
          auth_ok: true,
          poller: { ok: true, pid: 1 },
        }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.session_id, null)
    assert.deepEqual(calls, ['register', 'write'])
  })

  it('automation cold-launch promptText: register → write, no attach', async () => {
    const calls = []
    const projectId = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
    const promptText = [
      'DevSpec automation run waiting: "Smoke check"',
      `project_id=${projectId}`,
      'automation_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'run_id=11111111-2222-3333-4444-555555555555',
      '',
      '1. Register a live connection FIRST. Call register_connection: agent_name="Cursor".',
      '2. claim_automation_run({ run_id: "11111111-2222-3333-4444-555555555555", provider: "cursor" })',
    ].join('\n')
    const r = await fastConnect({
      localId,
      launchId,
      projectId,
      promptText,
      resolveAuth: () => ({
        ok: true,
        token: 't',
        mcp_url: 'https://example.test/api/mcp',
      }),
      resolveGitRemoteFn: () => null,
      resolveLocalFn: () => ({ action: 'register', connection_id: null }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async () => {},
      registerFn: async () => {
        calls.push('register')
        return { ok: true, connection_id: connectionId, project_id: projectId, codename: 'Ivory Llama' }
      },
      attachFn: async () => {
        calls.push('attach')
        return { ok: true }
      },
      writeFn: async (opts) => {
        calls.push('write')
        assert.equal(opts.sessionId, null)
        return {
          ok: true,
          connection_id: connectionId,
          session_id: null,
          session_codename: 'Ivory Llama',
          auth_ok: true,
          poller: { ok: true, pid: 1 },
        }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.session_id, null)
    assert.deepEqual(calls, ['register', 'write'])
  })

  it('aborts when register fails (no write)', async () => {
    const calls = []
    const phases = []
    const r = await fastConnect({
      localId,
      launchId,
      projectId,
      sessionId,
      resolveAuth: () => ({
        ok: true,
        token: 't',
        mcp_url: 'https://example.test/api/mcp',
      }),
      resolveGitRemoteFn: () => null,
      resolveLocalFn: () => ({ action: 'register' }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async (p) => {
        phases.push(p)
      },
      registerFn: async () => {
        calls.push('register')
        return { ok: false, error: 'server_rejected' }
      },
      attachFn: async () => {
        calls.push('attach')
        return { ok: true }
      },
      writeFn: async () => {
        calls.push('write')
        return { ok: true }
      },
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'server_rejected')
    assert.deepEqual(calls, ['register'])
    assert.equal(r.connection_id, null)
  })

  it('aborts when project_resolve fails', async () => {
    const r = await fastConnect({
      localId,
      launchId,
      projectId: 'Missing project', // only an explicit name needs discovery
      resolveAuth: () => ({
        ok: true,
        token: 't',
        mcp_url: 'https://example.test/api/mcp',
      }),
      resolveGitRemoteFn: () => 'https://github.com/example/none.git',
      resolveLocalFn: () => ({ action: 'register' }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async () => {},
      mcpCall: async () => ({
        projects: [],
        remote_match: { resolved_project_id: null, candidate_project_ids: [] },
      }),
      registerFn: async () => ({ ok: true, connection_id: connectionId }),
      writeFn: async () => ({ ok: true }),
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /No accessible project/)
  })

  it('hydrates a legacy live connection without erasing the server attachment', async () => {
    const result = await fastConnect({
      localId, cwd: process.cwd(), launchId,
      resolveAuth: () => ({ ok: true, token: 'fixture', mcp_url: 'https://example.test/api/mcp' }),
      resolveGitRemoteFn: () => null,
      resolveLocalFn: () => ({ action: 'already_live', connection_id: connectionId, session_id: sessionId }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'native' }), emitPhase: async () => {},
      registerFn: async () => ({ ok: true, connection_id: connectionId, session_id: sessionId, project_id: projectId, codename: 'Existing' }),
      writeFn: async opts => {
        assert.equal(opts.sessionId, sessionId)
        return { ok: true, session_codename: 'Existing', poller: { ok: true, reused: true } }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.session_id, sessionId)
    assert.equal(result.project_id, projectId)
  })

  it('already_live with saved scope and repository facts skips register when no new session', async () => {
    selectProjectContext(localId, 'https://example.test/api/mcp', { id: projectId, name: 'Project' }, 'explicit', projectHome)
    storeRepositorySnapshot(localId, {project_id:projectId, repository_context:{version:1,project_id:projectId,status:'available',repositories:[]}}, projectHome)
    const calls = []
    const r = await fastConnect({
      localId,
      launchId,
      resolveAuth: () => ({
        ok: true,
        token: 't',
        mcp_url: 'https://example.test/api/mcp',
      }),
      resolveLocalFn: () => ({
        action: 'already_live',
        connection_id: connectionId,
        session_id: sessionId,
        session_codename: 'Colorful Possum',
      }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async () => {},
      registerFn: async () => {
        calls.push('register')
        return { ok: true, connection_id: connectionId }
      },
      attachFn: async () => {
        calls.push('attach')
        return { ok: true }
      },
      writeFn: async (opts) => {
        calls.push('write')
        assert.equal(opts.connectionId, connectionId)
        return {
          ok: true,
          connection_id: connectionId,
          session_id: sessionId,
          session_codename: 'Colorful Possum',
          auth_ok: true,
          poller: { ok: true, reused: true, pid: 9 },
        }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.codename, 'Colorful Possum')
    assert.deepEqual(calls, ['write'])
  })

  it('noPoller: register/attach/write succeed even when poller is skipped (item f099fc6e)', async () => {
    const phases = []
    const r = await fastConnect({
      localId,
      cwd: process.cwd(),
      sessionId,
      launchId,
      projectId,
      noPoller: true,
      resolveAuth: () => ({
        ok: true,
        token: 'test-token',
        mcp_url: 'https://example.test/api/mcp',
        source: 'test',
      }),
      resolveGitRemoteFn: () => 'https://github.com/DevSpecAI/cursor-devspec-plugin.git',
      resolveLocalFn: () => ({ action: 'register', connection_id: null }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async (p) => {
        phases.push(p)
      },
      registerFn: async () => ({
        ok: true,
        connection_id: connectionId,
        codename: 'Restless Owl',
        project_id: projectId,
      }),
      attachFn: async () => ({ ok: true, connection_id: connectionId, session_id: sessionId }),
      writeFn: async (opts) => {
        assert.equal(opts.noPoller, true)
        return {
          ok: true,
          connection_id: connectionId,
          session_id: sessionId,
          session_codename: 'Restless Owl',
          mcp_url: 'https://example.test/api/mcp',
          auth_ok: true,
          poller: { ok: true, skipped: true, reason: 'no-poller' },
        }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.connection_id, connectionId)
    const ensure = phases.find((p) => p.phase === 'ensure_poller')
    assert.equal(ensure.outcome, 'ok')
    assert.equal(ensure.extra.deferred_until_resume, true)
  })

  it('poller failure remains fatal when noPoller is not set', async () => {
    const r = await fastConnect({
      localId,
      launchId,
      projectId,
      sessionId,
      resolveAuth: () => ({
        ok: true,
        token: 't',
        mcp_url: 'https://example.test/api/mcp',
      }),
      resolveGitRemoteFn: () => null,
      resolveLocalFn: () => ({ action: 'register' }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async () => {},
      registerFn: async () => ({
        ok: true,
        connection_id: connectionId,
        codename: 'Restless Owl',
        project_id: projectId,
      }),
      attachFn: async () => ({ ok: true, session_id: sessionId }),
      writeFn: async () => ({
        ok: true,
        connection_id: connectionId,
        session_id: sessionId,
        session_codename: 'Restless Owl',
        auth_ok: true,
        poller: {
          ok: false,
          error: 'refusing to spawn a poller without a valid --owner-pid',
        },
      }),
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
    assert.equal(r.connection_id, connectionId)
  })
})

describe('fastConnect --new (item e707e925)', () => {
  const connectionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const oldSessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const projectId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  const localId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const launchId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
  const newRoomId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  const auth = () => ({ ok: true, token: 'fixture', mcp_url: 'https://example.test/api/mcp' })

  /** Every injected seam, recording what was called and with what. */
  function harness({ action = 'register', create, attach } = {}) {
    const calls = []
    const creates = []
    const seams = {
      localId,
      launchId,
      resolveAuth: auth,
      resolveGitRemoteFn: () => null,
      detectLocalIdFn: () => ({ local_id: localId, source: 'arg' }),
      emitPhase: async () => {},
      resolveLocalFn: () => action === 'already_live'
        ? { action, connection_id: connectionId, session_id: oldSessionId, session_codename: 'Colorful Possum' }
        : { action, connection_id: null, session_id: null },
      registerFn: async (opts) => {
        calls.push('register')
        assert.equal(opts.localId, localId)
        return { ok: true, connection_id: connectionId, project_id: projectId, codename: 'Brave Otter' }
      },
      mcpCall: async (req) => {
        calls.push(req.name)
        creates.push(req)
        return create ? create(req) : { session_id: newRoomId, session_url: `https://example.test/session/${newRoomId}`, title: 'Fix the flaky test' }
      },
      attachFn: async (opts) => {
        calls.push(['attach', opts.sessionId])
        assert.equal(opts.connectionId, connectionId)
        return attach ? attach(opts) : { ok: true, connection_id: connectionId, session_id: opts.sessionId }
      },
      writeFn: async (opts) => {
        calls.push(['write', opts.sessionId, opts.title ?? null])
        return { ok: true, connection_id: connectionId, session_id: opts.sessionId, session_codename: opts.codename, auth_ok: true, poller: { ok: true, pid: 7 } }
      },
    }
    return { calls, creates, seams }
  }

  it('registers, creates a shared room in the confirmed project, then attaches to it and writes state', async () => {
    const { calls, creates, seams } = harness()
    const r = await fastConnect({ ...seams, newSession: true, title: 'Fix the flaky test' })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(calls, ['register', 'create_session', ['attach', newRoomId], ['write', newRoomId, 'Fix the flaky test']])
    assert.equal(creates.length, 1)
    assert.equal(creates[0].mcpUrl, 'https://example.test/api/mcp')
    assert.equal(creates[0].token, 'fixture')
    assert.deepEqual(creates[0].arguments, {
      session_type: 'agent_remote_control',
      access: 'shared',
      agent_name: 'Cursor',
      project_id: projectId,
      title: 'Fix the flaky test',
      session_codename: 'Brave Otter',
    })
    assert.equal(r.session_id, newRoomId)
    assert.equal(r.new_session, true)
    assert.equal(r.access, 'shared')
    assert.equal(r.session_url, `https://example.test/session/${newRoomId}`)
    assert.equal(r.connection_id, connectionId)
  })

  it('--new sends shared and --new --private sends private', async () => {
    const shared = harness()
    assert.equal((await fastConnect({ ...shared.seams, newSession: true })).ok, true)
    assert.equal(shared.creates[0].arguments.access, 'shared')
    assert.equal('title' in shared.creates[0].arguments, false)

    const secret = harness()
    const r = await fastConnect({ ...secret.seams, newSession: true, private: true })
    assert.equal(r.ok, true, r.error)
    assert.equal(secret.creates[0].arguments.access, 'private')
    assert.equal(r.access, 'private')
  })

  it('on an already-live conversation creates a room and attaches it without re-registering', async () => {
    selectProjectContext(localId, 'https://example.test/api/mcp', { id: projectId, name: 'Project' }, 'explicit', projectHome)
    storeRepositorySnapshot(localId, { project_id: projectId, repository_context: { version: 1, project_id: projectId, status: 'available', repositories: [] } }, projectHome)
    // DevSpec names the room `session_id`; `id` is read too.
    const { calls, creates, seams } = harness({ action: 'already_live', create: () => ({ id: newRoomId }) })
    const r = await fastConnect({ ...seams, newSession: true })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(calls, ['create_session', ['attach', newRoomId], ['write', newRoomId, null]])
    assert.equal(creates[0].arguments.project_id, projectId)
    assert.equal(creates[0].arguments.session_codename, 'Colorful Possum')
    assert.equal(r.session_id, newRoomId)
    assert.equal(r.action, 'already_live')
  })

  it('a create failure names the step, attaches nothing and claims no room', async () => {
    const { calls, seams } = harness({ create: () => { throw new Error('Remote control is not enabled for this project.') } })
    const r = await fastConnect({ ...seams, newSession: true })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'create_session_failed')
    assert.match(r.error, /^create_session_failed: Remote control is not enabled/)
    assert.equal(r.session_id, null)
    assert.deepEqual(calls, ['register', 'create_session'])
  })

  it('a create result without a room id is a create failure', async () => {
    const { calls, seams } = harness({ create: () => ({ title: 'No id' }) })
    const r = await fastConnect({ ...seams, newSession: true })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'create_session_failed')
    assert.equal(r.session_id, null)
    assert.deepEqual(calls, ['register', 'create_session'])
  })

  it('an attach failure after the create names the step and the unattached room, and writes nothing', async () => {
    const { calls, seams } = harness({ attach: () => ({ ok: false, error: 'connection_not_found' }) })
    const r = await fastConnect({ ...seams, newSession: true })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'attach_failed')
    assert.match(r.error, /^attach_failed: connection_not_found/)
    assert.equal(r.session_id, null)
    assert.equal(r.created_session_id, newRoomId)
    assert.deepEqual(calls, ['register', 'create_session', ['attach', newRoomId]])
  })

  it('--new with --session is refused before anything runs', async () => {
    const { calls, seams } = harness()
    let authResolved = false
    const r = await fastConnect({ ...seams, resolveAuth: () => { authResolved = true; return auth() }, newSession: true, sessionId: oldSessionId })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'new_with_session')
    assert.match(r.error, /--new/)
    assert.match(r.error, /--session/)
    assert.deepEqual(calls, [])
    assert.equal(authResolved, false)
  })

  it('--private without --new, alone or with --session, says it does nothing there and connects nothing', async () => {
    for (const extra of [{}, { sessionId: oldSessionId }]) {
      const { calls, seams } = harness()
      const r = await fastConnect({ ...seams, private: true, ...extra })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'private_without_new')
      assert.match(r.error, /--private does nothing/)
      assert.deepEqual(calls, [])
    }
  })

  it('without --new nothing is created', async () => {
    const { calls, seams } = harness()
    const r = await fastConnect({ ...seams, title: 'Ignored without --new' })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(calls, ['register', ['write', null, null]])
  })
})

describe('fast-connect CLI flags', () => {
  it('parses --new apart from --force-new, and --private, --help, -h and = forms', () => {
    const fresh = parseArgs(['fast-connect', '--new', '--title', 'A room', '--private'])
    assert.equal(fresh.new, true)
    assert.equal(fresh.forceNew, undefined)
    assert.equal(fresh.private, true)
    assert.equal(fresh.title, 'A room')
    assert.equal(parseArgs(['resolve-local', '--force-new']).forceNew, true)
    assert.equal(parseArgs(['fast-connect', '--help']).help, true)
    assert.equal(parseArgs(['fast-connect', '-h']).help, true)
    assert.equal(parseArgs(['fast-connect', '--title=Spaced room']).title, 'Spaced room')
    assert.equal(parseArgs(['fast-connect', '--session=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']).session, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  })

  const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote-control-state.mjs')
  for (const flag of ['--help', '-h']) {
    it(`fast-connect ${flag} prints usage, exits 0 and registers, writes and calls nothing`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fast-connect-help-home-'))
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fast-connect-help-cwd-'))
      try {
        // Everything a real connect would need except a token: were help not read
        // first, this would try to connect (and fail on auth, never on the network).
        const run = spawnSync(process.execPath, [SCRIPT, 'fast-connect', '--local-id', 'help-probe', '--new', '--title', 'Probe', flag], {
          cwd,
          env: { HOME: home, PATH: process.env.PATH },
          encoding: 'utf8',
          timeout: 20_000,
        })
        assert.equal(run.status, 0, run.stderr)
        assert.equal(run.stderr, '')
        for (const name of ['--local-id', '--agent', '--cwd', '--owner-pid', '--session', '--new', '--private', '--title', '--project', '--project-id', '--launch-id', '--codename', '--help']) {
          assert.ok(run.stdout.includes(name), `usage lists ${name}`)
        }
        assert.doesNotMatch(run.stdout, /"ok"/, 'help is usage text, not a connect result')
        assert.deepEqual(fs.readdirSync(home), [], 'no connection files under HOME')
        assert.deepEqual(fs.readdirSync(cwd), [], 'nothing written in the working folder')
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  }
})
