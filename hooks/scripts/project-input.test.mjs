#!/usr/bin/env node
/**
 * Unit tests for project-input.mjs and own-connection.mjs (item 56ba1b79):
 * mechanical stamping of connection_id, provenance_ref, request_ref, and local_turn
 * onto DevSpec MCP calls, stripping model-supplied request_ref, and refusing writes
 * when a turn carries multiple requests that would be recorded differently.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ownConnectionId, withOwnConnection } from './own-connection.mjs'
import { hookOutput, projectInput } from './project-input.mjs'
import { selectProjectContext } from './project-context.mjs'
import { appendRequestEvent } from './requests.mjs'

const MINE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CONVERSATION = 'cursor-conversation-56ba1b79'
const ENDPOINT = 'https://fixture.invalid/api/mcp?tool_namespace=devspec'
const PROJECT = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Fixture',
  organization: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Org' },
}
const REQ_A = '0000000a-0000-4000-8000-00000000000a'
const REQ_B = '0000000b-0000-4000-8000-00000000000b'
const REQ_T = '0000000c-0000-4000-8000-00000000000c'
const MSG_A = '1000000a-0000-4000-8000-00000000000a'
const MSG_B = '1000000b-0000-4000-8000-00000000000b'
const PROV_A = '2000000a-0000-4000-8000-00000000000a'
const PROV_B = '2000000b-0000-4000-8000-00000000000b'
const ALI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BRANDON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let home
let dir

function bond(connectionId, extra = {}) {
  fs.writeFileSync(
    path.join(dir, `${connectionId}.json`),
    JSON.stringify({
      connection_id: connectionId,
      enabled: true,
      agent_name: 'Cursor',
      local_id: CONVERSATION,
      ...extra,
    }),
    { mode: 0o600 },
  )
}

function writeMcpConfig(root) {
  fs.writeFileSync(
    path.join(root, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        devspec: { url: ENDPOINT },
      },
    }),
    { mode: 0o600 },
  )
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-project-input-'))
  dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeMcpConfig(home)
})

describe('ownConnectionId', () => {
  it('is the live connection bound to exactly this conversation', () => {
    bond(MINE)
    bond(OTHER, { local_id: 'another-conversation' })
    fs.writeFileSync(path.join(dir, `${MINE}.listener.json`), '{}')
    assert.equal(ownConnectionId(CONVERSATION, { home }), MINE)
  })

  it("never another conversation's, a disabled one, or another host's", () => {
    bond(OTHER, { local_id: 'another-conversation' })
    assert.equal(ownConnectionId(CONVERSATION, { home }), null)
    bond(MINE, { enabled: false })
    assert.equal(ownConnectionId(CONVERSATION, { home }), null)
    bond(MINE, { agent_name: 'Claude Code' })
    assert.equal(ownConnectionId(CONVERSATION, { home }), null)
  })

  it('names nobody when two connections claim the conversation', () => {
    bond(MINE)
    bond(OTHER)
    assert.equal(ownConnectionId(CONVERSATION, { home }), null)
  })
})

describe('withOwnConnection', () => {
  it('adds the connection to a call that names none', () => {
    assert.deepEqual(withOwnConnection('create_task', { title: 't' }, MINE), {
      title: 't',
      connection_id: MINE,
    })
    assert.deepEqual(withOwnConnection('search_memories', { query: 'q' }, MINE), {
      query: 'q',
      connection_id: MINE,
    })
  })

  it('leaves a call that names a connection or a room exactly as written', () => {
    const named = { title: 't', connection_id: OTHER }
    assert.equal(withOwnConnection('create_task', named, MINE), named)
    const room = { message: 'm', session_id: 'room' }
    assert.equal(withOwnConnection('post_session_message', room, MINE), room)
  })

  it('never aims a call whose subject is a connection', () => {
    for (const tool of [
      'register_connection',
      'attach_connection',
      'detach_connection',
      'heartbeat_connection',
      'poll_connection',
      'verify_agent_connection',
      'get_connection_dispatch',
      'report_pickup',
      'report_keepalive',
      'report_complete',
      'report_request',
    ]) {
      const args = {}
      assert.equal(withOwnConnection(tool, args, MINE), args, tool)
    }
  })

  it('changes nothing without a connection', () => {
    const args = { title: 't' }
    assert.equal(withOwnConnection('create_task', args, null), args)
  })
})

describe('projectInput mechanical stamping', () => {
  it('stamps project_id, connection_id, provenance_ref, and request_ref while stripping model-supplied request_ref', () => {
    selectProjectContext(CONVERSATION, ENDPOINT, PROJECT, 'explicit', home)
    bond(MINE)
    appendRequestEvent(
      MINE,
      {
        op: 'open',
        id: REQ_A,
        kind: 'command',
        message_id: MSG_A,
        provenance_ref: PROV_A,
        requested_by: ALI,
      },
      { dir },
    )
    appendRequestEvent(MINE, { op: 'current', ref: REQ_A }, { dir })

    const pre = projectInput(
      'pre',
      {
        conversation_id: CONVERSATION,
        cwd: home,
        tool_name: 'MCP:devspec__create_task',
        tool_input: { title: 'filed from room', request_ref: REQ_B },
      },
      { home },
    )
    assert.deepEqual(pre, {
      updated_input: {
        title: 'filed from room',
        project_id: PROJECT.id,
        connection_id: MINE,
        provenance_ref: PROV_A,
        request_ref: REQ_A,
      },
    })

    const before = projectInput(
      'before',
      {
        conversation_id: CONVERSATION,
        cwd: home,
        mcp_server_name: 'devspec',
        mcp_server_url: ENDPOINT,
        tool_name: 'devspec__create_task',
        tool_input: pre.updated_input,
      },
      { home },
    )
    assert.equal(before, null)
  })

  it('denies beforeMCPExecution when model-supplied request_ref bypassed preToolUse', () => {
    selectProjectContext(CONVERSATION, ENDPOINT, PROJECT, 'explicit', home)
    bond(MINE)
    appendRequestEvent(
      MINE,
      {
        op: 'open',
        id: REQ_A,
        kind: 'command',
        message_id: MSG_A,
        provenance_ref: PROV_A,
        requested_by: ALI,
      },
      { dir },
    )
    appendRequestEvent(MINE, { op: 'current', ref: REQ_A }, { dir })

    const before = projectInput(
      'before',
      {
        conversation_id: CONVERSATION,
        cwd: home,
        mcp_server_name: 'devspec',
        mcp_server_url: ENDPOINT,
        tool_name: 'devspec__create_task',
        tool_input: {
          title: 'spoofed',
          project_id: PROJECT.id,
          connection_id: MINE,
          request_ref: REQ_B,
        },
      },
      { home },
    )
    assert.equal(before.permission, 'deny')
  })

  it('stamps local_turn and command_turn_unbound onto post_session_message during a local terminal turn and strips provenance_ref', () => {
    selectProjectContext(CONVERSATION, ENDPOINT, PROJECT, 'explicit', home)
    bond(MINE, { session_id: '44444444-4444-4444-8444-444444444444' })
    appendRequestEvent(MINE, { op: 'open', id: REQ_T, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(MINE, { op: 'current', ref: REQ_T }, { dir })

    const pre = projectInput(
      'pre',
      {
        conversation_id: CONVERSATION,
        cwd: home,
        tool_name: 'MCP:devspec__post_session_message',
        tool_input: {
          message: 'Done!',
          complete_turn: true,
          provenance_ref: PROV_A,
        },
      },
      { home },
    )
    assert.deepEqual(pre, {
      updated_input: {
        message: 'Done!',
        complete_turn: true,
        project_id: PROJECT.id,
        connection_id: MINE,
        local_turn: true,
        command_turn_unbound: true,
      },
    })
  })

  it('refuses writes when a turn carries multiple requests that would be recorded differently', () => {
    selectProjectContext(CONVERSATION, ENDPOINT, PROJECT, 'explicit', home)
    bond(MINE)
    appendRequestEvent(
      MINE,
      {
        op: 'open',
        id: REQ_A,
        kind: 'command',
        message_id: MSG_A,
        provenance_ref: PROV_A,
        requested_by: ALI,
      },
      { dir },
    )
    appendRequestEvent(
      MINE,
      {
        op: 'open',
        id: REQ_B,
        kind: 'command',
        message_id: MSG_B,
        provenance_ref: PROV_B,
        requested_by: BRANDON,
      },
      { dir },
    )
    appendRequestEvent(MINE, { op: 'current', ref: REQ_A }, { dir })
    appendRequestEvent(MINE, { op: 'joined', id: REQ_B }, { dir })

    const pre = projectInput(
      'pre',
      {
        conversation_id: CONVERSATION,
        cwd: home,
        tool_name: 'MCP:devspec__record_memory',
        tool_input: { type: 'decision', title: 't', body: 'b' },
      },
      { home },
    )
    assert.equal(pre.permission, 'deny')
    assert.match(pre.user_message, /requests\.mjs" serve --connection-id/)
  })
})

describe('claims carry this conversation (item ef54cfcb)', () => {
  it('stamps the host conversation id onto a claim, over anything the model sent', () => {
    selectProjectContext(CONVERSATION, ENDPOINT, PROJECT, 'explicit', home)
    const pre = projectInput(
      'pre',
      {
        conversation_id: CONVERSATION,
        cwd: home,
        tool_name: 'MCP:devspec__claim_work_item',
        tool_input: { task_id: REQ_A, agent_branch: 'work/x', local_session_id: 'not-this-chat' },
      },
      { home },
    )
    assert.equal(pre.updated_input.local_session_id, CONVERSATION)
    assert.equal(pre.updated_input.project_id, PROJECT.id)
  })
})

describe('the hook always answers Cursor (item 46dd5fc4)', () => {
  // The preToolUse entry is fail-closed, and Cursor refuses a fail-closed hook that
  // prints nothing ("Permission denied", logged as blocked / empty_stdout), so the
  // no-op path must print an explicit empty answer. Run as Cursor runs it: a process
  // reading the hook input on stdin, with nothing connected and no project chosen.
  const script = fileURLToPath(new URL('./project-input.mjs', import.meta.url))
  const runHook = (mode, input) =>
    spawnSync(process.execPath, [script, mode], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    })

  it('lets a DevSpec call through before the conversation is connected or has a project', () => {
    const run = runHook('pre', {
      conversation_id: CONVERSATION,
      cwd: home,
      tool_name: 'MCP:devspec__create_session',
      tool_input: { session_type: 'agent_remote_control', title: 'New room' },
    })
    assert.equal(run.status, 0)
    assert.deepEqual(JSON.parse(run.stdout), {})
  })

  it('lets a project-free call through when there is nothing to stamp', () => {
    const run = runHook('pre', {
      conversation_id: CONVERSATION,
      cwd: home,
      tool_name: 'MCP:devspec__list_projects',
      tool_input: {},
    })
    assert.equal(run.status, 0)
    assert.deepEqual(JSON.parse(run.stdout), {})
  })

  it('still refuses what it refused before', () => {
    const run = runHook('pre', {
      conversation_id: CONVERSATION,
      cwd: home,
      tool_name: 'MCP:devspec__manage_plan',
      tool_input: {},
    })
    assert.equal(run.status, 0)
    assert.equal(JSON.parse(run.stdout).permission, 'deny')
  })

  it('refuses input it cannot read instead of printing nothing', () => {
    const run = runHook('pre', 'not json')
    assert.equal(run.status, 0)
    assert.equal(JSON.parse(run.stdout).permission, 'deny')
  })

  it('answers the server-aware check with no override when the call needs none', () => {
    assert.equal(
      hookOutput(
        'before',
        JSON.stringify({
          conversation_id: CONVERSATION,
          cwd: home,
          mcp_server_name: 'devspec',
          mcp_server_url: ENDPOINT,
          tool_name: 'devspec__create_session',
          tool_input: { title: 'New room' },
        }),
        { home },
      ),
      '{}',
    )
  })
})
