#!/usr/bin/env node
/**
 * DevSpec replies that carry an appended notice (item 75d3b14a).
 *
 * DevSpec appends an account notice (a paused project, an organisation out of funds or
 * read-only), a plugin notice, an agent-health block or a tell_person mark as further
 * text blocks after its answer. The plugin used to join every block before reading, so
 * any such reply became unreadable: a registration while the project was paused looked
 * like no registration. These tests send real replies over a real socket to the
 * plugin's shared call, and real hook input to the registration hook.
 *
 * Run: node --test hooks/scripts/tool-reply.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CursorMcpRefusal, mcpToolsCall } from './mcp-call.mjs'
import { projectInput } from './project-input.mjs'
import { readProjectContext } from './project-context.mjs'
import { readRepositorySnapshot } from './repository-context.mjs'
import { registerConnection } from './remote-control-state.mjs'
import { postRefusal } from './notice-reply.mjs'
import { readToolReply, replyNotice, REPLY_NOTICES_KEY } from './tool-reply.mjs'

const PROJECT = { id: '22222222-2222-4222-8222-222222222222', name: 'Website' }
const CONNECTION = '33333333-3333-4333-8333-333333333333'

// The shapes DevSpec sends (apps/web/lib/mcp/account-notice.ts, plugin-access.ts).
const ACCOUNT_NOTICE = {
  devspec_account_notice: {
    kind: 'project_paused',
    limited: 'Paid work in this project is paused.',
    why: 'An organisation admin paused it.',
    what_to_do: 'An organisation admin can resume it from the project settings.',
  },
}
const PLUGIN_NOTICE = {
  devspec_plugin_notice: { kind: 'no_plugin', limited: 'Fixture notice.', what_to_do: 'Install the plugin.' },
}
const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) })

/** A DevSpec stand-in on a real socket that answers every tools/call with `result`. */
async function withServer(result, run) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run(`http://127.0.0.1:${server.address().port}/api/mcp`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('readToolReply', () => {
  it('reads the answer from the first text block and keeps every later block', () => {
    const reply = readToolReply({ content: [text({ ok: true }), text(ACCOUNT_NOTICE), { type: 'image', data: 'x' }, text('plain words')] })
    assert.equal(reply.readable, true)
    assert.deepEqual(reply.answer, { ok: true })
    assert.deepEqual(reply.notices, [ACCOUNT_NOTICE, { text: 'plain words' }])
    assert.deepEqual(replyNotice(reply.notices, 'devspec_account_notice'), ACCOUNT_NOTICE.devspec_account_notice)
    assert.equal(replyNotice(reply.notices, 'devspec_plugin_notice'), null)
  })

  it('says when the answer is not JSON, and when there is no answer at all', () => {
    assert.deepEqual(readToolReply({ content: [text('Done.')] }), { answerText: 'Done.', readable: false, answer: undefined, notices: [] })
    assert.deepEqual(readToolReply({ content: [] }), { answerText: null, readable: false, answer: undefined, notices: [] })
    assert.deepEqual(readToolReply(null), { answerText: null, readable: false, answer: undefined, notices: [] })
  })
})

describe('mcpToolsCall: a reply with an appended notice', () => {
  it('returns the answer as before when DevSpec appended nothing', async () => {
    const answer = { connection_id: CONNECTION, stored: true }
    const data = await withServer({ content: [text(answer)] }, (mcpUrl) =>
      mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'get_task', arguments: {} }))
    assert.deepEqual(data, answer)
    assert.equal(Object.hasOwn(data, REPLY_NOTICES_KEY), false)
  })

  it('reads the answer and keeps an account notice and a plugin notice beside it', async () => {
    const answer = { id: 'task-1', delivery: { status: 'stored' } }
    const data = await withServer({ content: [text(answer), text(ACCOUNT_NOTICE), text(PLUGIN_NOTICE)] }, (mcpUrl) =>
      mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'post_session_message', arguments: {} }))
    assert.equal(data.id, 'task-1')
    assert.equal(data.delivery.status, 'stored')
    assert.equal(Object.hasOwn(data, 'raw'), false, 'the answer is read, not returned unreadable')
    assert.deepEqual(data[REPLY_NOTICES_KEY], [ACCOUNT_NOTICE, PLUGIN_NOTICE])
    assert.equal(replyNotice(data, 'devspec_account_notice').kind, 'project_paused')
  })

  it('returns the notices with includeMeta too, beside the hidden meta', async () => {
    const response = await withServer(
      { content: [text({ connection_id: CONNECTION }), text(ACCOUNT_NOTICE)], _meta: { devspec: { connection_capability: { version: 1, value: 'dvsc_x' } } } },
      (mcpUrl) => mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'register_connection', arguments: {}, includeMeta: true }),
    )
    assert.equal(response.data.connection_id, CONNECTION)
    assert.deepEqual(response.notices, [ACCOUNT_NOTICE])
    assert.equal(response.meta.devspec.connection_capability.value, 'dvsc_x')
    assert.equal(JSON.stringify(response.data).includes('dvsc_x'), false, 'meta stays out of the answer')
  })

  it('still treats a refusal as a refusal, with its structured details and its notices', async () => {
    const refusal = { code: 'project_paused', message: 'This project is paused.' }
    const error = await withServer({ isError: true, content: [text(refusal), text(ACCOUNT_NOTICE)] }, (mcpUrl) =>
      mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'create_task', arguments: {} }).then(() => null, (e) => e))
    assert.ok(error instanceof CursorMcpRefusal)
    assert.equal(error.message, JSON.stringify(refusal))
    assert.deepEqual(error.details, refusal, 'the refusal is read from its own block, not lost in a joined text')
    assert.deepEqual(error.notices, [ACCOUNT_NOTICE])
  })

  it('prefers structuredContent for a refusal and keeps a plain-text refusal message whole', async () => {
    const error = await withServer(
      { isError: true, content: [text('Choose a project.'), text(PLUGIN_NOTICE)], structuredContent: { code: 'project_choice_required' } },
      (mcpUrl) => mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'register_connection', arguments: {} }).then(() => null, (e) => e))
    assert.equal(error.message, 'Choose a project.')
    assert.deepEqual(error.details, { code: 'project_choice_required' })
    assert.deepEqual(error.notices, [PLUGIN_NOTICE])
  })

  it('keeps every block of an answer that is not JSON, the notices read out as well', async () => {
    const result = { content: [text('Done.'), text(ACCOUNT_NOTICE)] }
    const data = await withServer(result, (mcpUrl) => mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'x', arguments: {} }))
    assert.equal(data.raw, 'Done.')
    assert.deepEqual(data.result, result)
    assert.deepEqual(data[REPLY_NOTICES_KEY], [ACCOUNT_NOTICE])
  })
})

describe('callers of mcpToolsCall', () => {
  let home
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tool-reply-')) })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('connect registers and records the project while DevSpec appends an account notice', async () => {
    const answer = { connection_id: CONNECTION, project_id: PROJECT.id, project_selection: { version: 1, status: 'resolved', source: 'explicit', project: PROJECT } }
    const result = await withServer(
      { content: [text(answer), text(ACCOUNT_NOTICE)], _meta: { devspec: { connection_capability: { version: 1, value: 'dvsc_fixture' } } } },
      (mcpUrl) => registerConnection({
        cwd: home, localId: 'chat', projectId: PROJECT.id, projectHome: home,
        resolveAuth: () => ({ ok: true, token: 'dvs_fixture', mcp_url: mcpUrl }),
        emitPhase: async () => {},
        persistCapability: ({ capability }) => ({ ok: capability === 'dvsc_fixture' }),
      }).then((r) => ({ ...r, mcpUrl })),
    )
    assert.equal(result.ok, true, result.error)
    assert.equal(result.connection_id, CONNECTION)
    assert.equal(readProjectContext('chat', result.mcpUrl, home).project.id, PROJECT.id)
    assert.deepEqual(result[REPLY_NOTICES_KEY], [ACCOUNT_NOTICE], 'the notice reaches whoever reads the connect result')
  })

  it('a post DevSpec stored is no refusal, notice or not; one it did not store keeps its notices', () => {
    assert.equal(postRefusal({ result: { delivery: { status: 'stored' }, [REPLY_NOTICES_KEY]: [ACCOUNT_NOTICE] } }), null)
    const notStored = { delivery: { status: 'not_stored', reason: 'paused' }, [REPLY_NOTICES_KEY]: [ACCOUNT_NOTICE] }
    assert.deepEqual(postRefusal({ result: notStored }), { message: null, details: notStored })
  })
})

describe('the registration hook (afterMCPExecution)', () => {
  let home
  const endpoint = 'https://fixture.invalid/api/mcp?tool_namespace=devspec'
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tool-reply-hook-')) })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
  const after = (tool, args, result) => projectInput('after', {
    conversation_id: 'chat', mcp_server_name: 'devspec', url: endpoint,
    tool_name: tool, tool_input: JSON.stringify(args), result_json: JSON.stringify(result),
  }, { home })

  for (const [label, notice] of [['an account notice', ACCOUNT_NOTICE], ['a plugin notice', PLUGIN_NOTICE]]) {
    it(`records the chosen project when the receipt carries ${label}`, () => {
      const receipt = { connection_id: CONNECTION, project_id: PROJECT.id, project_selection: { version: 1, status: 'resolved', source: 'explicit', project: PROJECT } }
      after('devspec__register_connection', { local_id: 'chat', project_id: PROJECT.id }, { content: [text(receipt), text(notice)] })
      assert.equal(readProjectContext('chat', endpoint, home)?.project?.id, PROJECT.id)
    })
  }

  it('stores the repositories and refreshes the rules from register and attach receipts that carry a notice', () => {
    const receipt = {
      connection_id: CONNECTION, project_id: PROJECT.id,
      project_selection: { version: 1, status: 'resolved', source: 'explicit', project: PROJECT },
      repository_context: { version: 1, project_id: PROJECT.id, status: 'available', repositories: [] },
      project_agent_rules: 'Registered rules',
    }
    after('devspec__register_connection', { local_id: 'chat', project_id: PROJECT.id }, { content: [text(receipt), text(ACCOUNT_NOTICE)] })
    assert.equal(readRepositorySnapshot('chat', home)?.rules?.project_agent_rules, 'Registered rules')
    after('devspec__attach_connection', { connection_id: CONNECTION }, { content: [text({ connection_id: CONNECTION, project_agent_rules: 'Attached rules' }), text(ACCOUNT_NOTICE)] })
    assert.equal(readRepositorySnapshot('chat', home).rules.project_agent_rules, 'Attached rules')
  })

  it('records nothing from a refusal, notice or not', () => {
    after('devspec__register_connection', { local_id: 'chat', project_id: PROJECT.id }, {
      isError: true,
      content: [text({ connection_id: CONNECTION, project_id: PROJECT.id, project_selection: { project: PROJECT } }), text(ACCOUNT_NOTICE)],
    })
    assert.equal(readProjectContext('chat', endpoint, home), null)
  })
})
