import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import {
  AMBIGUOUS_REFERENCE_MESSAGE,
  MULTIPLE_CLAIMS_MESSAGE,
  appendReference,
  findProjectPin,
  handleHook,
  inspectReferences,
  parseHookInput,
  parseMcpExecution,
  parseReadableCommit,
  readConversationState,
  writeConversationState,
} from './provenance-assistance.mjs'

const PROJECT = '11111111-2222-3333-4444-555555555555'
const ITEM_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ITEM_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const roots = []

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix = 'devspec-cursor-provenance-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

function pinnedRepo() {
  const outsideHome = tempRoot()
  const repo = path.join(outsideHome, 'repo')
  const nested = path.join(repo, 'packages', 'app')
  fs.mkdirSync(path.join(repo, '.devspec'), { recursive: true })
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(repo, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
  return { home: path.join(outsideHome, 'home'), repo, nested }
}

function mcp(toolName, result, args = {}, conversationId = 'chat-a') {
  return {
    conversation_id: conversationId,
    tool_name: toolName,
    tool_input: JSON.stringify(args),
    result_json: JSON.stringify(result),
  }
}

function observeClaim(stateRoot, item = ITEM_A, conversationId = 'chat-a', nowMs) {
  handleHook('afterMCPExecution', mcp(
    'devspec__claim_work_item',
    { claim_success: true, project_id: PROJECT, action_item: { id: item, status: 'active' } },
    { action_item_id: item },
    conversationId,
  ), { stateRoot, nowMs })
}

function pre(command, cwd, stateRoot, extra = {}) {
  return handleHook('preToolUse', {
    conversation_id: extra.conversation_id || 'chat-a',
    tool_name: extra.tool_name || 'Shell',
    tool_input: { command },
    tool_use_id: extra.tool_use_id || 'tool-1',
    cwd,
  }, { stateRoot, nowMs: extra.nowMs, pinOptions: { home: extra.home, repoRoot: extra.repoRoot } })
}

describe('readable Cursor commit shapes', () => {
  it('reads bare, cd-prefix, and git -C forms and preserves the target cwd', () => {
    const cwd = '/workspace/main'
    const bare = parseReadableCommit("git commit -m 'ship'", cwd)
    assert.equal(bare?.targetCwd, cwd)
    assert.equal(bare?.message, 'ship')
    assert.equal(appendReference(bare, ITEM_A), `git commit -m 'ship [devspec:${ITEM_A}]'`)

    const cd = parseReadableCommit("cd '../work tree' && git commit --allow-empty -m \"ship\"", cwd)
    assert.equal(cd?.targetCwd, '/workspace/work tree')
    assert.equal(appendReference(cd, ITEM_A), `cd '../work tree' && git commit --allow-empty -m \"ship [devspec:${ITEM_A}]\"`)

    const dashC = parseReadableCommit("git -C '../work tree' commit -m 'ship'", cwd)
    assert.equal(dashC?.targetCwd, '/workspace/work tree')
  })

  it('fails open for opaque, compound, history-rewriting, and expansion forms', () => {
    for (const command of [
      "cd repo && git commit -m 'x' && git push",
      "git -c user.name=x commit -m 'x'",
      "git commit --amend -m 'x'",
      "git commit --am -m 'x'",
      "git commit -c HEAD -m 'x'",
      "git commit -C HEAD -m 'x'",
      "git commit --fixup=HEAD -m 'x'",
      "git commit --squash=HEAD -m 'x'",
      "git commit --reuse-message=HEAD -m 'x'",
      "git commit -CHEAD -m 'x'",
      "git commit -m \"$SUBJECT\"",
      "git commit -m 'x' $(git status)",
      "git commit --trailer \"Reviewed-by: $(whoami)\" -m 'x'",
      "git commit *.js -m 'x'",
      "cd repo* && git commit -m 'x'",
      "git -C ~/repo commit -m 'x'",
      "git -C %TEMP% commit -m 'x'",
      "git -C '%TEMP%' commit -m 'x'",
      "git -C repo\\ name commit -m 'x'",
      "git commit -m unquoted",
      "eval git commit -m 'x'",
      "git commit -F message.txt",
      "git commit -m 'x' | tee out",
      "git commit -m 'x'; echo done",
      "git commit -m 'x'\necho done",
    ]) assert.equal(parseReadableCommit(command, '/workspace'), null, command)
  })

  it('distinguishes one valid full reference from malformed or multiple markers', () => {
    assert.deepEqual(inspectReferences(`ship [devspec:${ITEM_A}]`), {
      valid: [ITEM_A],
      malformedOrAmbiguous: false,
    })
    assert.equal(inspectReferences('ship [devspec:aaaaaaaa]').malformedOrAmbiguous, true)
    assert.equal(inspectReferences(`ship [devspec:${ITEM_A}`).malformedOrAmbiguous, true)
    assert.equal(inspectReferences(`ship [devspec : ${ITEM_A}]`).malformedOrAmbiguous, true)
    assert.equal(inspectReferences(`ship [devspec:${ITEM_A}] [devspec:${ITEM_B}]`).malformedOrAmbiguous, true)
  })
})

describe('project jurisdiction', () => {
  it('uses the nearest valid pin through the repository root and never the home pin', () => {
    const { home, repo, nested } = pinnedRepo()
    assert.deepEqual(findProjectPin(nested, { home, repoRoot: repo }), {
      projectId: PROJECT,
      path: path.join(repo, '.devspec', 'project.json'),
    })
    fs.mkdirSync(path.join(home, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(home, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
    assert.equal(findProjectPin(home, { home, repoRoot: home }), null)
  })

  it('finds an untracked main-checkout pin from a linked worktree', () => {
    const root = tempRoot()
    const home = path.join(root, 'home')
    const main = path.join(root, 'main')
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(path.join(main, '.devspec'), { recursive: true })
    fs.mkdirSync(worktree)
    fs.writeFileSync(path.join(main, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
    assert.deepEqual(findProjectPin(worktree, { home, repoRoot: worktree, mainWorktree: main }), {
      projectId: PROJECT,
      path: path.join(main, '.devspec', 'project.json'),
    })
  })

  it('fails open on missing, malformed, and non-uuid pins without bypassing a local invalid pin', () => {
    const root = tempRoot()
    const home = path.join(root, 'home')
    const repo = path.join(root, 'repo')
    const main = path.join(root, 'main')
    fs.mkdirSync(path.join(repo, '.devspec'), { recursive: true })
    fs.mkdirSync(path.join(main, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(main, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
    assert.equal(findProjectPin(repo, { home, repoRoot: repo, mainWorktree: null }), null)
    fs.writeFileSync(path.join(repo, '.devspec', 'project.json'), '{broken')
    assert.equal(findProjectPin(repo, { home, repoRoot: repo, mainWorktree: main }), null)
    fs.writeFileSync(path.join(repo, '.devspec', 'project.json'), JSON.stringify({ project_id: 'short' }))
    assert.equal(findProjectPin(repo, { home, repoRoot: repo, mainWorktree: main }), null)
  })
})

describe('claim observation and commit decisions', () => {
  it('accepts a valid reference without any live claim and allows no-claim/offline work', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    assert.equal(pre(`git commit -m 'ship [devspec:${ITEM_B}]'`, repo, stateRoot, { home, repoRoot: repo }), null)
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo }), null)
    assert.equal(pre("git commit -m 'broken [devspec:not-a-uuid]'", repo, stateRoot, { home, repoRoot: repo })?.permission, 'deny')
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_name: 'Write' }), null)
  })

  it('stamps exactly one observed claim through structured preToolUse updated_input', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot)
    const output = pre("cd . && git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_use_id: 'stamp-1' })
    assert.equal(output?.permission, 'allow')
    assert.equal(output?.updated_input?.command, `cd . && git commit -m 'ship [devspec:${ITEM_A}]'`)
    assert.match(output?.agent_message || '', new RegExp(ITEM_A))
    assert.equal(readConversationState('chat-a', stateRoot).pending_stamps['stamp-1'].action_item_id, ITEM_A)

    const reported = handleHook('postToolUse', {
      conversation_id: 'chat-a', tool_name: 'Shell', tool_use_id: 'stamp-1', cwd: repo,
    }, { stateRoot, pinOptions: { home, repoRoot: repo } })
    assert.match(reported?.additional_context || '', new RegExp(`appended \\[devspec:${ITEM_A}\\]`))
    assert.equal(readConversationState('chat-a', stateRoot).pending_stamps['stamp-1'], undefined)
  })

  it('never overwrites an existing different reference', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    assert.equal(pre(`git commit -m 'follow-up [devspec:${ITEM_B}]'`, repo, stateRoot, { home, repoRoot: repo }), null)
  })

  it('never stamps a claim observed for a different DevSpec project', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    handleHook('afterMCPExecution', mcp(
      'claim_work_item',
      { claim_success: true, project_id: '99999999-8888-7777-6666-555555555555', id: ITEM_A },
      { action_item_id: ITEM_A },
    ), { stateRoot })
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo }), null)
  })

  it('denies only readable ambiguity with observed recovery and never terminates the turn', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    observeClaim(stateRoot, ITEM_B)
    const multiple = pre("git -C . commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo })
    assert.equal(multiple?.permission, 'deny')
    assert.equal(multiple?.agent_message, MULTIPLE_CLAIMS_MESSAGE)
    assert.equal(multiple?.continue, undefined)
    assert.equal(multiple?.stopReason, undefined)

    const malformed = pre("git commit -m 'ship [devspec:short]'", repo, stateRoot, { home, repoRoot: repo })
    assert.equal(malformed?.permission, 'deny')
    assert.equal(malformed?.agent_message, AMBIGUOUS_REFERENCE_MESSAGE)
  })

  it('fails open for opaque shell and marker-less folders even with a claim', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot)
    assert.equal(pre("eval git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo }), null)
    const markerless = path.join(path.dirname(repo), 'elsewhere')
    fs.mkdirSync(markerless)
    assert.equal(pre("git commit -m 'ship'", markerless, stateRoot, { home, repoRoot: markerless }), null)
  })

  it('clears only the matching claim after successful follow-through', () => {
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    observeClaim(stateRoot, ITEM_B)
    handleHook('afterMCPExecution', mcp('record_implementation', { status: 'implemented' }, { action_item_id: ITEM_A }), { stateRoot })
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((claim) => claim.id), [ITEM_B])
    handleHook('afterMCPExecution', mcp('record_implementation', { error: 'not recorded' }, { action_item_id: ITEM_B }), { stateRoot })
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((claim) => claim.id), [ITEM_B])
  })

  it('expires stale claim observations and fails open for legacy timeless state', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    const observed = Date.parse('2026-02-01T00:00:00Z')
    observeClaim(stateRoot, ITEM_A, 'chat-a', observed)
    assert.match(pre("git commit -m 'fresh'", repo, stateRoot, { home, repoRoot: repo, nowMs: observed + 1_000 })?.updated_input?.command || '', new RegExp(ITEM_A))
    assert.equal(pre("git commit -m 'stale'", repo, stateRoot, { home, repoRoot: repo, nowMs: observed + 24 * 60 * 60 * 1_000 + 1 }), null)

    writeConversationState('chat-old', { active_claims: [ITEM_A] }, stateRoot)
    assert.equal(pre("git commit -m 'legacy'", repo, stateRoot, {
      home, repoRoot: repo, conversation_id: 'chat-old', nowMs: observed + 1_000,
    }), null)
  })
})

describe('bounded after-the-fact nudge', () => {
  it('injects at most one postToolUse nudge per conversation/project and never blocks the edit', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    const first = handleHook('postToolUse', {
      conversation_id: 'chat-a', tool_name: 'Write', tool_use_id: 'edit-1', cwd: repo,
      tool_input: { path: path.join(repo, 'src', 'one.ts') },
    }, { stateRoot, pinOptions: { home, repoRoot: repo } })
    assert.match(first?.additional_context || '', /edit already completed/i)
    assert.equal(first?.permission, undefined)
    const second = handleHook('postToolUse', {
      conversation_id: 'chat-a', tool_name: 'Edit', tool_use_id: 'edit-2', cwd: repo,
      tool_input: { file_path: 'src/two.ts' },
    }, { stateRoot, pinOptions: { home, repoRoot: repo } })
    assert.equal(second, null)
  })

  it('uses the concrete edited path rather than the shell cwd for jurisdiction', () => {
    const first = pinnedRepo()
    const second = pinnedRepo()
    const secondProject = '99999999-8888-7777-6666-555555555555'
    fs.writeFileSync(path.join(second.repo, '.devspec', 'project.json'), JSON.stringify({ project_id: secondProject }))
    const stateRoot = tempRoot()
    const output = handleHook('postToolUse', {
      conversation_id: 'chat-cross', tool_name: 'Write', cwd: first.repo,
      tool_input: { path: path.join(second.repo, 'src', 'file.ts') },
    }, { stateRoot, pinOptions: { home: first.home, repoRoot: second.repo } })
    assert.match(output?.additional_context || '', new RegExp(secondProject))
  })

  it('suppresses the nudge when a claim exists or jurisdiction is uncertain', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot)
    assert.equal(handleHook('postToolUse', {
      conversation_id: 'chat-a', tool_name: 'Write', cwd: repo, tool_input: { path: 'src/one.ts' },
    }, { stateRoot, pinOptions: { home, repoRoot: repo } }), null)
    assert.equal(handleHook('postToolUse', {
      conversation_id: 'chat-b', tool_name: 'Write', cwd: path.dirname(repo), tool_input: {},
    }, { stateRoot, pinOptions: { home, repoRoot: path.dirname(repo) } }), null)
  })
})

describe('executable fail-open boundary', () => {
  it('exits zero and emits no decision when state persistence fails', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = path.join(tempRoot(), 'not-a-directory')
    fs.writeFileSync(stateRoot, 'file')
    const script = fileURLToPath(new URL('./provenance-assistance.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, 'postToolUse'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DEVSPEC_CURSOR_PROVENANCE_STATE_DIR: stateRoot },
      input: JSON.stringify({
        conversation_id: 'chat-fail-open', tool_name: 'Write', cwd: repo,
        tool_input: { path: path.join(repo, 'file.ts') },
      }),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /failed open/i)
  })
})

describe('hook input and MCP result validation', () => {
  it('parses hook JSON and requires explicit matching claim success', () => {
    assert.deepEqual(parseHookInput('{"conversation_id":"chat-a"}'), { conversation_id: 'chat-a' })
    assert.deepEqual(parseHookInput('broken'), {})
    assert.equal(parseMcpExecution(mcp('devspec__claim_work_item', {
      claim_success: true, project_id: PROJECT.toUpperCase(), id: ITEM_A.toUpperCase(),
    }, { action_item_id: ITEM_A, pinned_project_id: PROJECT })).successful, true)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, id: ITEM_A }, { action_item_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { ok: true, project_id: PROJECT, id: ITEM_A }, { action_item_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('other__claim_work_item', { claim_success: true, project_id: PROJECT, id: ITEM_A }, { action_item_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, project_id: PROJECT, id: ITEM_B }, { action_item_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, project_id: PROJECT, id: ITEM_A }, {
      action_item_id: ITEM_A, project_id: '99999999-8888-7777-6666-555555555555',
    })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, project_id: 'invalid', id: ITEM_A }, { action_item_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('record_implementation', { action_item: { lifecycle: 'done' } }, { action_item_id: ITEM_A })).successful, true)
    assert.equal(parseMcpExecution({ tool_name: 'claim_work_item', tool_input: '{}', result_json: 'broken' }).successful, false)
  })
})
