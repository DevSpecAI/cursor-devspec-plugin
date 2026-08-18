import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  POST_EDIT_WARNING,
  classifyShellCommand,
  handleHook,
  parseHookInput,
  parseMcpExecution,
  readScopeState,
  resolveConversationId,
} from './mutation-boundary.mjs'

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function tempStateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-boundary-'))
  roots.push(root)
  return root
}

function scope(conversationId, repoRoot) {
  return { conversationId, repoRoot }
}

function mcp(toolName, result = { ok: true }, args = {}) {
  return {
    tool_name: toolName,
    tool_input: JSON.stringify(args),
    result_json: JSON.stringify(result),
  }
}

describe('hook input and MCP parsing', () => {
  it('parses valid object JSON and fails closed to an empty object', () => {
    assert.deepEqual(parseHookInput('{"conversation_id":"chat-a"}'), { conversation_id: 'chat-a' })
    assert.deepEqual(parseHookInput('not-json'), {})
    assert.equal(resolveConversationId({}, { CURSOR_CONVERSATION_ID: 'chat-env' }), 'chat-env')
  })

  it('requires explicit claim success and a matching returned item id when present', () => {
    const parsed = parseMcpExecution(mcp(
      'devspec__claim_work_item',
      {
        claim_success: true,
        action_item: { id: 'item-1', status: 'active' },
        implementation_contract: 'Discuss failure and possible_conflict handling in tests.',
      },
      { action_item_id: 'item-1' },
    ))
    assert.equal(parsed.verb, 'claim_work_item')
    assert.equal(parsed.successful, true)
    assert.equal(parsed.arguments.action_item_id, 'item-1')
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true }, { action_item_id: 'item-1' })).successful, true)
    assert.equal(parseMcpExecution(mcp('mcp_devspec_claim_work_item', { claim_success: true })).verb, 'claim_work_item')
    assert.equal(parseMcpExecution(mcp('claim_work_item', { ok: true }, { action_item_id: 'item-1' })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claimed: true }, { action_item_id: 'item-1' })).successful, false)
    assert.equal(parseMcpExecution(mcp(
      'claim_work_item',
      { claim_success: true, action_item_id: 'item-2' },
      { action_item_id: 'item-1' },
    )).successful, false)
    assert.equal(parseMcpExecution({ tool_name: 'claim_work_item', result_json: 'not-json', tool_input: '{}' }).successful, false)
    assert.equal(parseMcpExecution({ tool_name: 'claim_work_item', result: { claim_success: true }, arguments: { action_item_id: 'wrong-fields' } }).successful, false)
    assert.equal(parseMcpExecution(mcp('other_server_tool', { ok: true })).successful, false)
  })

  it('lets outer structured failure markers veto nested active claim state', () => {
    const args = { action_item_id: 'item-1' }
    for (const result of [
      { claim_success: true, status: 'possible_conflict', action_item: { id: 'item-1', status: 'active' } },
      { claim_success: true, conflict: { action_item_id: 'item-2' }, action_item: { id: 'item-1', status: 'active' } },
      { claim_success: true, error: { message: 'claim failed' }, action_item: { id: 'item-1', status: 'active' } },
      { claim_success: true, errors: [{ message: 'claim failed' }], action_item: { id: 'item-1', status: 'active' } },
      { claim_success: true, claim_status: 'not-claimed', action_item: { id: 'item-1', status: 'active' } },
      { claim_success: true, claimed: false, action_item: { id: 'item-1', status: 'active' } },
    ]) {
      assert.equal(parseMcpExecution(mcp('claim_work_item', result, args)).successful, false, JSON.stringify(result))
    }
  })
})

describe('conversation + repo scoped state', () => {
  it('arms only the exact scope after a successful claim', () => {
    const stateRoot = tempStateRoot()
    const a = scope('chat-a', '/repo/one')
    const otherChat = scope('chat-b', '/repo/one')
    const otherRepo = scope('chat-a', '/repo/two')

    handleHook(
      'afterMCPExecution',
      mcp('claim_work_item', { claim_success: true, action_item_id: 'item-1' }, { action_item_id: 'item-1' }),
      { scope: a, stateRoot, now: '2026-01-01T00:00:00.000Z' },
    )

    assert.equal(readScopeState(a, stateRoot)?.armed, true)
    assert.equal(readScopeState(a, stateRoot)?.action_item_id, 'item-1')
    assert.equal(readScopeState(otherChat, stateRoot), null)
    assert.equal(readScopeState(otherRepo, stateRoot), null)
    assert.equal(handleHook('beforeShellExecution', { command: 'rm x' }, { scope: a, stateRoot }), null)
    assert.equal(
      handleHook('beforeShellExecution', { command: 'rm x' }, { scope: otherChat, stateRoot })?.permission,
      'deny',
    )
  })

  it('does not arm on a failed claim and clears only a matching claimed item', () => {
    const stateRoot = tempStateRoot()
    const own = scope('chat-a', '/repo/one')
    handleHook('afterMCPExecution', mcp('claim_work_item', { claim_success: true, status: 'possible_conflict', action_item: { status: 'active' } }, { action_item_id: 'item-1' }), { scope: own, stateRoot })
    assert.equal(readScopeState(own, stateRoot), null)

    handleHook('afterMCPExecution', mcp('claim_work_item', { claim_success: true, action_item_id: 'item-2' }, { action_item_id: 'item-1' }), { scope: own, stateRoot })
    assert.equal(readScopeState(own, stateRoot), null)

    handleHook('afterMCPExecution', mcp('claim_work_item', { claim_success: true, action_item_id: 'item-1' }, { action_item_id: 'item-1' }), { scope: own, stateRoot })
    handleHook('afterMCPExecution', mcp('record_implementation', { error: 'not recorded' }, { action_item_id: 'item-1' }), { scope: own, stateRoot })
    assert.equal(readScopeState(own, stateRoot)?.armed, true)

    handleHook('afterMCPExecution', mcp('record_implementation', { status: 'implemented' }, { action_item_id: 'item-2' }), { scope: own, stateRoot })
    assert.equal(readScopeState(own, stateRoot)?.armed, true)

    handleHook('afterMCPExecution', mcp('record_implementation', { status: 'implemented' }, { action_item_id: 'item-1' }), { scope: own, stateRoot })
    assert.equal(readScopeState(own, stateRoot)?.armed, false)
    assert.equal(readScopeState(own, stateRoot)?.cleared_by, 'record_implementation')
  })

  it('does not arm a successful claim without a structured item id', () => {
    const stateRoot = tempStateRoot()
    const own = scope('chat-a', '/repo/one')
    handleHook('afterMCPExecution', mcp('claim_work_item', { claim_success: true }), { scope: own, stateRoot })
    assert.equal(readScopeState(own, stateRoot), null)
  })
})

describe('read-only compound shell classifier', () => {
  it('allows ordinary and reported cross-repository inspection forms', () => {
    const inspection = [
      'WT=/other/repo',
      "printf '%s\\n' status",
      'git -C "$WT" status --short --branch',
      'git -C "$WT" diff --stat',
      'git -C "$WT" ls-files --others --exclude-standard',
      'git -C "$WT" log --oneline --decorate -8',
    ].join('\n')
    for (const command of ['pwd', 'ls -la', 'cat -- README.md', 'head -20 README.md', 'git status --short', 'git diff --stat', inspection]) {
      assert.equal(classifyShellCommand(command).allowed, true, command)
    }
  })

  it('denies mutation, expansion, hidden mutation, and redirection', () => {
    for (const command of [
      'rm README.md', 'npm test', 'git checkout main', 'git diff --output=diff.txt',
      'cat README.md > copy.md', 'pwd && touch x', 'git status | tee out', 'ls $(touch x)',
      'sort input -o owned', 'uniq input owned', 'find . -fprint0 owned', 'X=-delete; find . "$X"',
      'PATH=.:$PATH git status', 'GIT_EXTERNAL_DIFF=rm git diff', 'git -c alias.status=touch status',
      'git branch -D main', 'printf -v PATH .', '',
    ]) assert.equal(classifyShellCommand(command).allowed, false, command)
  })

  it('keeps beforeShellExecution denials actionable and non-stopping', () => {
    const output = handleHook('beforeShellExecution', { command: 'touch x' }, { scope: scope('chat-deny', '/repo/deny'), stateRoot: tempStateRoot() })
    assert.equal(output?.permission, 'deny')
    assert.equal(output?.stopReason, undefined)
    assert.equal(output?.continue, undefined)
    assert.match(output?.agent_message || '', /claim the covering item and retry/i)
    assert.match(output?.agent_message || '', /read-only investigation remains available/i)
  })
})

describe('afterFileEdit audit honesty', () => {
  it('records the observed violation and says the edit was not prevented or reverted', () => {
    const stateRoot = tempStateRoot()
    const own = scope('chat-edit', '/repo/edit')
    const output = handleHook(
      'afterFileEdit',
      { file_path: 'src/changed.ts' },
      { scope: own, stateRoot, now: '2026-01-02T03:04:05.000Z' },
    )

    assert.equal(output?.continue, false)
    assert.equal(output?.stopReason, POST_EDIT_WARNING)
    assert.equal(output?.followup_message, POST_EDIT_WARNING)
    assert.match(output?.agent_message || '', /after it occurred/i)
    assert.match(output?.agent_message || '', /did not prevent or revert/i)
    assert.deepEqual(readScopeState(own, stateRoot)?.last_violation, {
      event: 'afterFileEdit',
      file_path: 'src/changed.ts',
      observed_at: '2026-01-02T03:04:05.000Z',
    })
  })

  it('does not warn after the same scope is armed', () => {
    const stateRoot = tempStateRoot()
    const own = scope('chat-edit', '/repo/edit')
    handleHook('afterMCPExecution', mcp('claim_work_item', { claim_success: true, action_item_id: 'item-1' }, { action_item_id: 'item-1' }), { scope: own, stateRoot })
    assert.equal(handleHook('afterFileEdit', { file_path: 'x' }, { scope: own, stateRoot }), null)
  })
})
