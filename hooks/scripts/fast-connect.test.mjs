#!/usr/bin/env node
/**
 * Mechanical fast-connect (item 1cc2a2d5).
 * Run: node --test hooks/scripts/fast-connect.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { fitsShellOutput, readNoteText } from './hook-context-budget.mjs'
import { selectProjectContext } from './project-context.mjs'
import { storeRepositorySnapshot } from './repository-context.mjs'
import { formatBoundedCliStderr, installBoundedCliStderr, parseArgs } from './remote-control-state.mjs'
let projectHome
beforeEach(() => { projectHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-connect-project-')) })
afterEach(() => fs.rmSync(projectHome, { recursive: true, force: true }))
import {
  fastConnect as connectImpl,
  formatFastConnectCliOutput,
  parseSessionIdFromPrompt,
  resolveProjectForConnect,
  writeStreamAndFlush,
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
  it('reconnect reattaches the prior session when no --session or --new is passed, returns short summary with plugin_root, and refuses missing conversation id (item 66ad4866)', async () => {
    const calls = []
    const r = await fastConnect({
      localId,
      launchId,
      projectId,
      resolveAuth: () => ({ ok: true, token: 't', mcp_url: 'https://example.test/api/mcp' }),
      resolveGitRemoteFn: () => null,
      resolveLocalFn: () => ({
        action: 'reconnect',
        connection_id: connectionId,
        session_id: sessionId,
        session_codename: 'Quiet Fox',
      }),
      detectLocalIdFn: () => ({ local_id: localId, source: 'env:CURSOR_CONVERSATION_ID' }),
      emitPhase: async () => {},
      registerFn: async () => {
        calls.push('register')
        return {
          ok: true,
          connection_id: connectionId,
          project_id: projectId,
          session_id: null,
          codename: 'Quiet Fox',
          project_selection: { status: 'resolved', project: { id: projectId, name: 'DevSpec' } },
          repository_context: { version: 1, project_id: projectId, status: 'available', repositories: [] },
          project_agent_rules: 'Long rules that must not be dumped inline',
          github_identity: { status: 'link_required', url: 'https://app.devspec.ai/api/github/link?state=xyz' },
        }
      },
      attachFn: async (opts) => {
        calls.push(['attach', opts.sessionId])
        return { ok: true, connection_id: connectionId, session_id: opts.sessionId }
      },
      writeFn: async (opts) => {
        calls.push(['write', opts.sessionId])
        return { ok: true, connection_id: connectionId, session_id: opts.sessionId, session_codename: 'Quiet Fox', auth_ok: true, poller: { ok: true, pid: 11 } }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.action, 'reconnect')
    assert.equal(r.session_id, sessionId)
    assert.equal(r.project_name, 'DevSpec')
    assert.equal(r.repository_count, 0)
    assert.ok(typeof r.plugin_root === 'string' && r.plugin_root.length > 0)
    assert.equal(r.github_identity?.status, 'link_required')
    assert.match(r.github_status, /NOT LINKED/)
    assert.equal('project_context' in r, false)
    assert.doesNotMatch(JSON.stringify(r), /Long rules that must not be dumped inline/)
    assert.deepEqual(calls, ['register', ['attach', sessionId], ['write', sessionId]])

    // Never guesses or fabricates a conversation id when missing.
    const missing = await fastConnect({
      detectLocalIdFn: () => ({ local_id: null, source: null }),
    })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /conversation ID/)
    assert.equal(missing.local_id, null)

    // --name and --name=... map to codename.
    assert.equal(parseArgs(['fast-connect', '--name', 'My Agent']).codename, 'My Agent')
    assert.equal(parseArgs(['connect', '--name=My Agent']).codename, 'My Agent')
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

  it('writes an oversized 100-candidate project_choice_required refusal whole to a note instead of exceeding Cursor Shell ceiling', async () => {
    const { formatFastConnectCliOutput } = await import('./fast-connect.mjs')
    const { fitsShellOutput, readNoteText } = await import('./hook-context-budget.mjs')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fc60-100-choices-'))
    try {
      const candidates = Array.from({ length: 150 }, (_, i) => ({
        id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
        name: `Project Number ${i} — Organization Workspace Candidate`,
        organization_name: `Acme Organization ${i}`,
      }))
      const refusal = {
        ok: false,
        code: 'project_choice_required',
        error: 'Several accessible projects have that name. Choose a project and organisation.',
        project_selection: { version: 1, status: 'choice_required', reason: 'ambiguous_name', candidates },
        candidates: candidates.map((c) => c.id),
      }
      const out = formatFastConnectCliOutput(refusal, { home })
      assert.equal(fitsShellOutput(out), true, `CLI output must fit Cursor Shell ceiling, got ${out.length} chars`)
      const parsed = JSON.parse(out)
      assert.equal(parsed.ok, false)
      assert.equal(parsed.code, 'project_choice_required')
      assert.equal(parsed.project_selection.status, 'choice_required')
      assert.equal(parsed.project_selection.candidate_count, 150)
      assert.equal(parsed.project_selection.omitted_inline, true)
      assert.ok(parsed.complete_output_note?.id)
      assert.ok(parsed.complete_output_note?.command)
      const full = JSON.parse(readNoteText(parsed.complete_output_note.id, { home }))
      assert.equal(full.project_selection.candidates.length, 150)
      assert.equal(full.candidates, undefined, 'duplicate top-level candidate ID array is omitted')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('bounds the note receipt even when error text itself exceeds the Shell ceiling, and keeps structured candidates + recovery when note write fails', async () => {
    const { formatFastConnectCliOutput } = await import('./fast-connect.mjs')
    const { fitsShellOutput, readNoteText } = await import('./hook-context-budget.mjs')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fc60-bounds-'))
    const blockedHome = path.join(home, 'not-a-dir')
    fs.writeFileSync(blockedHome, 'file blocking mkdir', 'utf8')
    try {
      const hugeError = `Server refusal: ${'E'.repeat(25_000)}`
      const outHuge = formatFastConnectCliOutput(
        { ok: false, code: 'register_failed', error: hugeError },
        { home },
      )
      assert.equal(fitsShellOutput(outHuge), true, `oversized-error receipt must fit Shell ceiling, got ${outHuge.length}`)
      const parsedHuge = JSON.parse(outHuge)
      assert.equal(parsedHuge.omitted_fields_in_note, true)
      assert.ok(parsedHuge.complete_output_note?.id)
      const fullHuge = JSON.parse(readNoteText(parsedHuge.complete_output_note.id, { home }))
      assert.equal(fullHuge.error, hugeError)

      const hugeSession = 'S'.repeat(25_000)
      const outHugeSession = formatFastConnectCliOutput(
        { ok: false, code: 'project_choice_required', session_id: hugeSession, error: 'Choose project' },
        { home },
      )
      assert.equal(fitsShellOutput(outHugeSession), true, `oversized-session receipt must fit Shell ceiling, got ${outHugeSession.length}`)
      const parsedHugeSession = JSON.parse(outHugeSession)
      assert.equal(parsedHugeSession.omitted_fields_in_note, true)
      assert.equal(parsedHugeSession.session_id, undefined)
      assert.equal(JSON.parse(readNoteText(parsedHugeSession.complete_output_note.id, { home })).session_id, hugeSession)

      const candidates = Array.from({ length: 150 }, (_, i) => ({
        id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
        name: `Project Number ${i} — Organization Workspace Candidate`,
        organization_name: `Acme Organization ${i}`,
      }))
      const outFailedWrite = formatFastConnectCliOutput(
        {
          ok: false,
          code: 'project_choice_required',
          error: 'Several accessible projects have that name. Choose a project and organisation.',
          project_selection: { version: 1, status: 'choice_required', reason: 'ambiguous_repository', candidates },
          candidates: candidates.map((c) => c.id),
        },
        { home: blockedHome },
      )
      assert.equal(fitsShellOutput(outFailedWrite), true, `note-failure fallback must fit Shell ceiling, got ${outFailedWrite.length}`)
      const parsedFallback = JSON.parse(outFailedWrite)
      assert.equal(parsedFallback.code, 'project_choice_required')
      assert.equal(parsedFallback.project_selection.candidate_count, 150)
      assert.ok(parsedFallback.project_selection.returned_count > 0, 'keeps as many complete structured candidates as fit')
      assert.equal(parsedFallback.project_selection.candidates.length, parsedFallback.project_selection.returned_count)
      assert.equal(parsedFallback.project_selection.omitted_count, 150 - parsedFallback.project_selection.returned_count)
      assert.equal(parsedFallback.project_selection.omitted_candidates_require_writable_notes, true)
      assert.equal(parsedFallback.project_selection.recovery_tool, undefined, 'must not point at general list_projects for server-filtered choices')
      assert.ok(parsedFallback.complete_output_note_error)
      assert.doesNotMatch(parsedFallback.recovery, /list_projects/)
      assert.match(parsedFallback.recovery, /re-run connect/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('flushes complete inline 50-candidate project_choice_required JSON to stdout on a backpressured pipe before exiting (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    // 1. Unit check: writeStreamAndFlush waits for a slow 4096-byte backpressured Writable to finish draining.
    const received = []
    let flushed = false
    const slowStream = new Writable({
      highWaterMark: 4096,
      write(chunk, _enc, cb) {
        received.push(Buffer.from(chunk))
        setTimeout(() => {
          flushed = true
          cb()
        }, 40)
      },
    })
    const payload = 'x'.repeat(12_500)
    await writeStreamAndFlush(slowStream, payload)
    assert.equal(flushed, true, 'must wait for slow stream write callback before returning')
    assert.equal(Buffer.concat(received).toString('utf8'), payload)

    // 2. End-to-end CLI check: 50-candidate choice_required (~12 KB) over a paused pipe arrives complete and valid JSON.
    const candidates = Array.from({ length: 50 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `Pipe Project ${i}`,
      organization_name: `Pipe Org ${i}`,
      matched_by: ['repository'],
    }))
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed?.id ?? 1,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                code: 'project_choice_required',
                error: 'Several accessible projects match. Choose a project and organisation.',
                project_selection: { version: 1, status: 'choice_required', reason: 'ambiguous_repository', candidates },
              }),
            }],
          },
        }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pipe-flush-'))
    const script = fileURLToPath(new URL('./remote-control-state.mjs', import.meta.url))
    try {
      fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
      fs.writeFileSync(
        path.join(home, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { devspec: { url: `http://127.0.0.1:${port}/api/mcp` } } }),
      )
      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            script,
            'fast-connect',
            '--local-id', 'pipe-flush-conv',
            '--owner-pid', String(process.pid),
            '--cwd', home,
            '--host-token', 'dvs_pipe_test_token',
            '--no-poller',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              DEVSPEC_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
              DEVSPEC_MCP_TOKEN: 'dvs_pipe_test_token',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        // Pause stdout to simulate pipe backpressure before draining.
        child.stdout.pause()
        const chunks = []
        let stderr = ''
        child.stderr.on('data', (c) => { stderr += c.toString() })
        setTimeout(() => {
          child.stdout.on('data', (c) => chunks.push(c))
          child.stdout.resume()
        }, 100)
        child.on('error', reject)
        child.on('close', (code) => {
          const out = Buffer.concat(chunks).toString('utf8')
          if (!out) return reject(new Error(`empty stdout (code=${code}, stderr=${stderr})`))
          resolve({ stdout: out, stderr, code })
        })
      })
      assert.equal(code, 1)
      assert.equal(stderr, '', 'non-Git cwd must not leak git stderr into Cursor Shell output')
      assert.ok(Buffer.byteLength(stdout, 'utf8') > 8192, `expected > 8 KB JSON, got ${Buffer.byteLength(stdout, 'utf8')}`)
      assert.ok(fitsShellOutput(stdout + stderr))
      const parsed = JSON.parse(stdout)
      assert.equal(parsed.code, 'project_choice_required')
      assert.equal(parsed.project_selection.candidates.length, 50)
      assert.equal(parsed.project_selection.candidates[49].name, 'Pipe Project 49')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps combined stdout + stderr within fitsShellOutput in a non-Git folder with near-limit 80-candidate project choices and respects stderr reserve (3c5147a7 / 91d7b47c / 4e32d1a5)', async () => {
    const candidates = Array.from({ length: 80 }, (_, idx) => ({
      project_id: `00000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      name: `Near Limit Project ${idx}`,
      organization_id: `10000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      organization_name: `Org ${idx}`,
    }))
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                code: 'project_choice_required',
                error: 'Several accessible projects match. Choose a project and organisation.',
                project_selection: { version: 1, status: 'choice_required', reason: 'ambiguous_repository', candidates },
              }),
            }],
          },
        }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-nongit-80-'))
    const script = fileURLToPath(new URL('./remote-control-state.mjs', import.meta.url))
    try {
      fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
      fs.writeFileSync(
        path.join(home, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { devspec: { url: `http://127.0.0.1:${port}/api/mcp` } } }),
      )
      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            script,
            'fast-connect',
            '--local-id', 'nongit-80-conv',
            '--owner-pid', String(process.pid),
            '--cwd', home,
            '--host-token', 'dvs_pipe_test_token',
            '--no-poller',
          ],
          {
            cwd: home,
            env: {
              ...process.env,
              HOME: home,
              DEVSPEC_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
              DEVSPEC_MCP_TOKEN: 'dvs_pipe_test_token',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => { stdout += c.toString() })
        child.stderr.on('data', (c) => { stderr += c.toString() })
        child.on('error', reject)
        child.on('close', (code) => resolve({ stdout, stderr, code }))
      })
      assert.equal(code, 1)
      assert.equal(stderr, '', 'git remote probe in a non-Git folder must not write to stderr')
      assert.ok(
        fitsShellOutput(stdout + stderr),
        `combined stdout (${stdout.length}) + stderr (${stderr.length}) must fit fitsShellOutput`,
      )
      const parsed = JSON.parse(stdout)
      assert.equal(parsed.code, 'project_choice_required')
      if (parsed.project_selection?.omitted_inline) {
        assert.ok(parsed.complete_output_note?.command)
      } else {
        assert.equal(parsed.project_selection.candidates.length, 80)
      }

      // Also verify that explicit stderr reserve pushes a near-limit result into a sealed note.
      const reserve = 'stderr diagnostic '.repeat(25)
      const nearLimit = {
        ok: false,
        code: 'project_choice_required',
        error: 'Choose a project.',
        project_selection: { version: 1, status: 'choice_required', reason: 'ambiguous_repository', candidates },
      }
      // Pad one candidate so fullText alone fits (~19,900 chars) but reserve + fullText exceeds 20,000.
      const baseLen = (JSON.stringify(nearLimit, null, 2) + '\n').length
      if (baseLen < 19_900) {
        nearLimit.project_selection.candidates[0].description = 'd'.repeat(19_900 - baseLen)
      }
      const formatted = formatFastConnectCliOutput(nearLimit, { home, reserve })
      assert.ok(fitsShellOutput(reserve + formatted), 'reserve + formatted stdout must fit fitsShellOutput')
      const receipt = JSON.parse(formatted)
      assert.equal(receipt.project_selection.omitted_inline, true)
      assert.ok(receipt.complete_output_note?.command)
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('bounds stderr within fitsShellOutput when --prompt-file or unknown CLI args exceed 20,000 characters (3c5147a7 / 91d7b47c)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-promptfile-long-'))
    const script = fileURLToPath(new URL('./remote-control-state.mjs', import.meta.url))
    const runCliChild = (cliArgs, customHome = home) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...cliArgs], {
          cwd: customHome,
          env: { ...process.env, HOME: customHome },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => { stdout += c.toString() })
        child.stderr.on('data', (c) => { stderr += c.toString() })
        child.on('error', reject)
        child.on('close', (code) => resolve({ stdout, stderr, code }))
      })
    try {
      const longPath = 'x'.repeat(24_000)
      const r1 = await runCliChild(['fast-connect', '--prompt-file', longPath])
      assert.equal(r1.code, 1)
      assert.ok(
        fitsShellOutput(r1.stdout + r1.stderr),
        `overlong --prompt-file combined output (${(r1.stdout + r1.stderr).length}) must fit fitsShellOutput`,
      )
      assert.match(r1.stderr, /--prompt-file/)
      assert.match(r1.stderr, /actual_length 24000/)
      assert.match(r1.stderr, /shell_limit_chars 20000/)
      assert.match(r1.stderr, /cat ~\/\.devspec\/notes\/[0-9a-f]{16}\.md/)

      // Even when ~/.devspec/notes cannot be written, stderr still stays inside fitsShellOutput.
      const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-promptfile-broken-'))
      try {
        fs.mkdirSync(path.join(brokenHome, '.devspec'), { recursive: true })
        fs.writeFileSync(path.join(brokenHome, '.devspec', 'notes'), 'file blocking notes dir')
        const r2 = await runCliChild(['fast-connect', '--prompt-file', longPath], brokenHome)
        assert.equal(r2.code, 1)
        assert.ok(fitsShellOutput(r2.stdout + r2.stderr))
        assert.match(r2.stderr, /actual_length 24000/)
        assert.match(r2.stderr, /shell_limit_chars 20000/)
      } finally {
        fs.rmSync(brokenHome, { recursive: true, force: true })
      }

      // Overlong unknown CLI command is also bounded.
      const r3 = await runCliChild(['z'.repeat(24_000)])
      assert.equal(r3.code, 2)
      assert.ok(fitsShellOutput(r3.stdout + r3.stderr))
      assert.match(r3.stderr, /actual_length 24000/)

      // When prior stderr leaves too little room (only 20 chars) for the smallest visible note pointer or
      // refusal, formatters explicitly refuse with field, limit, actual_length, note/counts, and recovery
      // instead of overflowing fitsShellOutput or silently returning an empty string (reqs 3c5147a7 / 91d7b47c).
      const tightReserve = 'e'.repeat(19_980)
      assert.throws(
        () => formatFastConnectCliOutput({ ok: false, error: 'x'.repeat(25_000) }, { home, reserve: tightReserve }),
        (err) => {
          assert.equal(err.code, 'shell_output_limit_exceeded')
          assert.equal(err.field, 'reserve')
          assert.equal(err.limit, 20_000)
          assert.ok(err.actual_length > 20_000)
          assert.ok(err.note?.id && err.note?.command, 'must still surface the saved note pointer')
          return true
        },
      )

      const brokenHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tight-broken-'))
      try {
        fs.mkdirSync(path.join(brokenHome2, '.devspec'), { recursive: true })
        fs.writeFileSync(path.join(brokenHome2, '.devspec', 'notes'), 'file blocking notes dir')
        const candidatePayload = {
          ok: false,
          code: 'project_choice_required',
          error: 'Multiple projects matched',
          project_selection: {
            version: 1,
            status: 'multiple_matches',
            candidates: [
              { id: '1', name: 'A', detail: 'd'.repeat(10_000) },
              { id: '2', name: 'B', detail: 'd'.repeat(10_000) },
              { id: '3', name: 'C', detail: 'd'.repeat(10_000) },
            ],
          },
        }
        // When moderate reserve still fits the compact fallback, candidate counts and recovery are preserved whole.
        const modReserve = 'e'.repeat(19_400)
        const compactFallbackOut = formatFastConnectCliOutput(candidatePayload, { home: brokenHome2, reserve: modReserve })
        assert.ok(fitsShellOutput(modReserve + compactFallbackOut))
        const parsedFallback = JSON.parse(compactFallbackOut)
        assert.equal(parsedFallback.candidate_count, 3)
        assert.equal(parsedFallback.returned_count, 0)
        assert.equal(parsedFallback.omitted_count, 3)
        assert.equal(parsedFallback.complete_output_note_failed, true)
        assert.match(parsedFallback.recovery, /--project/)

        // When tight reserve cannot fit even the compact refusal with counts and recovery, refuse explicitly.
        assert.throws(
          () => formatFastConnectCliOutput(candidatePayload, { home: brokenHome2, reserve: tightReserve }),
          (err) => {
            assert.equal(err.code, 'shell_output_limit_exceeded')
            assert.equal(err.field, 'reserve')
            assert.equal(err.limit, 20_000)
            assert.equal(err.complete_output_note_failed, true)
            assert.equal(err.candidate_count, 3)
            assert.equal(err.returned_count, 0)
            assert.equal(err.omitted_count, 3)
            assert.match(err.recovery, /--project/)
            return true
          },
        )
        assert.throws(
          () => formatBoundedCliStderr('y'.repeat(25_000), { home: brokenHome2, reserve: tightReserve }),
          (err) => {
            assert.equal(err.code, 'shell_output_limit_exceeded')
            assert.equal(err.field, 'reserve')
            assert.equal(err.limit, 20_000)
            assert.equal(err.complete_output_note_failed, true)
            return true
          },
        )
      } finally {
        fs.rmSync(brokenHome2, { recursive: true, force: true })
      }

      // Oversized browser-approval stderr (19,900-char URL) during connect is saved whole in a sealed note
      // via installBoundedCliStderr, leaving headroom so combined stdout + stderr always fits fitsShellOutput
      // and neither the approval URL nor the final sign_in_pending result is cut (reqs 3c5147a7 / 91d7b47c).
      const hugeApprovalUrl = `https://app.devspec.ai/approve?token=${'u'.repeat(19_900)}`
      const approvalLine = `DevSpec: approve Cursor in your browser to turn on remote control and commit tracking (staging). If it did not open, open this link: ${hugeApprovalUrl}\n`
      const origWrite = process.stderr.write
      let capturedRawStderr = ''
      process.stderr.write = (chunk, enc, cb) => {
        capturedRawStderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        const done = typeof enc === 'function' ? enc : cb
        if (typeof done === 'function') done()
        return true
      }
      const guard = installBoundedCliStderr({ label: 'remote-control-state', home })
      try {
        process.stderr.write(approvalLine)
        const pendingResult = {
          ok: false,
          code: 'sign_in_pending',
          sign_in_url: hugeApprovalUrl,
          error: `Still waiting for your OK in the browser (${hugeApprovalUrl}).`,
        }
        const stdoutOut = formatFastConnectCliOutput(pendingResult, {
          home,
          reserve: guard.getEmittedStderr(),
        })
        assert.ok(
          fitsShellOutput(capturedRawStderr + stdoutOut),
          `combined browser-approval stderr (${capturedRawStderr.length}) + stdout (${stdoutOut.length}) must fit fitsShellOutput`,
        )
        assert.match(capturedRawStderr, /notes\/[0-9a-f]{16}\.md/, 'oversized browser-approval message must be saved whole in a sealed note')
        const noteMatch = /notes\/([0-9a-f]{16})\.md/.exec(capturedRawStderr)
        const savedApproval = readNoteText(noteMatch[1], { home })
        assert.ok(savedApproval && savedApproval.includes(hugeApprovalUrl), 'sealed stderr note must preserve the complete 19,900-char approval URL')
        const parsedStdout = JSON.parse(stdoutOut)
        assert.ok(parsedStdout.complete_output_note?.id, 'oversized sign_in_pending stdout must also be saved whole in a sealed note')
      } finally {
        guard.restore()
        process.stderr.write = origWrite
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
