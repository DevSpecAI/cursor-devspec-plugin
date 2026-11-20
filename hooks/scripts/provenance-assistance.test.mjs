import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { saveLogin } from './auth-store.mjs'
import { DEFAULT_MCP_URL } from './devspec-server.mjs'
import {
  MALFORMED_REFERENCE_MESSAGE,
  MULTIPLE_CLAIMS_MESSAGE,
  ONLINE_REFERENCE_TIMEOUT_MS,
  appendReference,
  confirmReferenceOnline,
  findProjectPin,
  gitMainWorktree,
  handleHook,
  inspectReferences,
  parseHookInput,
  parseMcpExecution,
  parseReadableCommit,
  readConversationState,
  unresolvedReferenceMessage,
  writeConversationState,
} from './provenance-assistance.mjs'
import { unlinkedCommitText, unrecordedClaimText, unrecordedCommitText } from './git-stand-in.mjs'
import { selectProjectContext } from './project-context.mjs'
import { catCall, noteFiles, noteIdIn } from '../../tests/helpers/note-reads.mjs'
import { readNoteText } from './hook-context-budget.mjs'

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

// The shape DevSpec's claim_work_item really returns: the claimed task's own fields at
// the top level and no project_id (item ef54cfcb). The call carries the project_id
// project-input.mjs stamped from the conversation's chosen project.
function claimResponse(item) {
  return { id: item, title: 'Fixture task', agent_activity: 'implementing', agent_branch: 'work/fixture', claim_success: true, work_claim_ref: '44444444-4444-4444-8444-444444444444' }
}

// How Cursor hands afterMCPExecution the reply (recorded live on cursor-agent
// 2026.10.22): the MCP envelope, DevSpec's answer in the first text block and any notice
// DevSpec appends in a block of its own after it.
function envelope(answer, ...notices) {
  return {
    content: [answer, ...notices].map((block) => ({ type: 'text', text: JSON.stringify(block) })),
    isError: false,
  }
}

const PLUGIN_NOTICE = { devspec_plugin_notice: { kind: 'no_plugin', limited: 'Fixture notice.' } }

function observeClaim(stateRoot, item = ITEM_A, conversationId = 'chat-a', nowMs) {
  handleHook('afterMCPExecution', mcp(
    'devspec__claim_work_item',
    envelope(claimResponse(item)),
    { task_id: item, project_id: PROJECT },
    conversationId,
  ), { stateRoot, nowMs })
}

/**
 * What postToolUse hands the agent once the Shell call `toolUseId` has run. A commit
 * note arrives as a pointer to a note, offered until read: this returns the note's
 * text as `additional_context`, and then reads it the way the agent would, so the next
 * commit's note starts a delivery of its own.
 */
function noteAfter(stateRoot, toolUseId = 'tool-1', conversationId = 'chat-a') {
  const out = handleHook('postToolUse', { conversation_id: conversationId, tool_name: 'Shell', tool_use_id: toolUseId }, { stateRoot, home: stateRoot })
  const id = noteIdIn(out?.additional_context)
  if (!id) return out
  for (const file of noteFiles(stateRoot, id)) {
    handleHook('postToolUse', catCall(stateRoot, file, { conversation: conversationId }), { stateRoot, home: stateRoot })
  }
  return { additional_context: readNoteText(id, { home: stateRoot }) }
}

function pre(command, cwd, stateRoot, extra = {}) {
  return handleHook('preToolUse', {
    conversation_id: extra.conversation_id || 'chat-a',
    tool_name: extra.tool_name || 'Shell',
    tool_input: { command },
    tool_use_id: extra.tool_use_id || 'tool-1',
    cwd,
  }, {
    stateRoot,
    env: extra.env,
    nowMs: extra.nowMs,
    pinOptions: { home: extra.home, repoRoot: extra.repoRoot },
    mainWorktree: extra.mainWorktree,
    resolveAuth: extra.resolveAuth,
    onlineCall: extra.onlineCall,
    onlineTimeoutMs: extra.onlineTimeoutMs,
    // These cover the command-text path: no git stand-in line (git-stand-in.test.mjs).
    prepareStandIn: extra.prepareStandIn ?? (() => null),
  })
}

describe('readable Cursor commit shapes', () => {
  it('reads bare, cd-prefix, git add &&, and git -C forms and preserves the target cwd', () => {
    const cwd = '/workspace/main'
    const bare = parseReadableCommit("git commit -m 'ship'", cwd)
    assert.equal(bare?.targetCwd, cwd)
    assert.equal(bare?.message, 'ship')
    assert.equal(appendReference(bare, ITEM_A), `git commit -m 'ship [devspec:${ITEM_A}]'`)

    const cd = parseReadableCommit("cd '../work tree' && git commit --allow-empty -m \"ship\"", cwd)
    assert.equal(cd?.targetCwd, '/workspace/work tree')
    assert.equal(appendReference(cd, ITEM_A), `cd '../work tree' && git commit --allow-empty -m \"ship [devspec:${ITEM_A}]\"`)

    const gitAdd = parseReadableCommit("git add src/index.ts && git commit -m 'ship'", cwd)
    assert.equal(gitAdd?.targetCwd, cwd)
    assert.equal(gitAdd?.message, 'ship')
    assert.equal(appendReference(gitAdd, ITEM_A), `git add src/index.ts && git commit -m 'ship [devspec:${ITEM_A}]'`)

    const dashC = parseReadableCommit("git -C '../work tree' commit -m 'ship'", cwd)
    assert.equal(dashC?.targetCwd, '/workspace/work tree')

    const cursorTrailer = parseReadableCommit(
      `git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" --allow-empty -m 'ship'`, cwd,
    )
    assert.equal(cursorTrailer?.message, 'ship')
  })

  it('reads -F - <<\'DELIM\', -m "$(cat <<\'DELIM\' … DELIM)", and readable/writable -F <path> multi-line forms and round-trips stamped commands through real git commit', () => {
    const repo = tempRoot('devspec-cursor-git-roundtrip-')
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Cursor MultiLine Test'])
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'cursor-multiline@example.invalid'])

    // 1. git commit -F - <<'MSG'
    const stdinHeredoc = [
      "git commit --allow-empty -F - <<'MSG'",
      'feat: multi-line via stdin heredoc',
      '',
      'Explain why the change is needed in the body.',
      'MSG',
    ].join('\n')
    const parsedStdin = parseReadableCommit(stdinHeredoc, repo)
    assert.equal(parsedStdin?.targetCwd, repo)
    assert.equal(parsedStdin?.message, 'feat: multi-line via stdin heredoc\n\nExplain why the change is needed in the body.')
    const stampedStdin = appendReference(parsedStdin, ITEM_A)
    assert.equal(stampedStdin, [
      "git commit --allow-empty -F - <<'MSG'",
      `feat: multi-line via stdin heredoc [devspec:${ITEM_A}]`,
      '',
      'Explain why the change is needed in the body.',
      'MSG',
    ].join('\n'))
    execFileSync('/bin/sh', ['-c', stampedStdin], { cwd: repo })
    const log1 = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' }).trim()
    assert.equal(log1, `feat: multi-line via stdin heredoc [devspec:${ITEM_A}]\n\nExplain why the change is needed in the body.`)

    // Also --file=- and cd prefix with heredoc
    const fileEqDash = parseReadableCommit("cd . && git commit --file=- <<'EOF'\nsubject only\nEOF", repo)
    assert.equal(fileEqDash?.message, 'subject only')
    assert.equal(appendReference(fileEqDash, ITEM_A), `cd . && git commit --file=- <<'EOF'\nsubject only [devspec:${ITEM_A}]\nEOF`)

    // 2. git commit -m "$(cat <<'MSG' ... MSG\n)" and closed-on-header form
    const catSub = [
      'git commit --allow-empty -m "$(cat <<\'MSG\'',
      'fix: multi-line via cat substitution',
      '',
      'Second paragraph with details.',
      'MSG',
      ')"',
    ].join('\n')
    const parsedCat = parseReadableCommit(catSub, repo)
    assert.equal(parsedCat?.targetCwd, repo)
    assert.equal(parsedCat?.message, 'fix: multi-line via cat substitution\n\nSecond paragraph with details.')
    const stampedCat = appendReference(parsedCat, ITEM_A)
    assert.equal(stampedCat, [
      'git commit --allow-empty -m "$(cat <<\'MSG\'',
      `fix: multi-line via cat substitution [devspec:${ITEM_A}]`,
      '',
      'Second paragraph with details.',
      'MSG',
      ')"',
    ].join('\n'))
    execFileSync('/bin/sh', ['-c', stampedCat], { cwd: repo })
    const log2 = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' }).trim()
    assert.equal(log2, `fix: multi-line via cat substitution [devspec:${ITEM_A}]\n\nSecond paragraph with details.`)

    const catClosedOnHeader = parseReadableCommit('git commit --allow-empty --message "$(cat <<\'EOF\')"\nchore: header close\n\nBody.\nEOF', repo)
    assert.equal(catClosedOnHeader?.message, 'chore: header close\n\nBody.')

    // 3. git commit -F <path> / --file=<path> when <path> exists, is readable, and is writable
    const msgFile = path.join(repo, 'COMMIT_MSG.txt')
    fs.writeFileSync(msgFile, 'refactor: commit from file\n\nBody from file.\n', 'utf8')
    const parsedFile = parseReadableCommit('git commit --allow-empty -F COMMIT_MSG.txt', repo)
    assert.equal(parsedFile?.targetCwd, repo)
    assert.equal(parsedFile?.message, 'refactor: commit from file\n\nBody from file.')
    const stampedFile = appendReference(parsedFile, ITEM_A)
    assert.match(stampedFile, new RegExp(`refactor: commit from file \\[devspec:${ITEM_A}\\]`))
    execFileSync('/bin/sh', ['-c', stampedFile], { cwd: repo })
    const log3 = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' }).trim()
    assert.equal(log3, `refactor: commit from file [devspec:${ITEM_A}]\n\nBody from file.`)

    const parsedLongFile = parseReadableCommit('git commit --allow-empty --file=COMMIT_MSG.txt', repo)
    assert.equal(parsedLongFile?.message, 'refactor: commit from file\n\nBody from file.')
  })

  it('fails open for opaque, compound, history-rewriting, expansion, and ambiguous multi-line forms', () => {
    const dir = tempRoot('devspec-cursor-fail-open-')
    const readonlyFile = path.join(dir, 'readonly.txt')
    fs.writeFileSync(readonlyFile, 'feat: readonly message\n', 'utf8')
    fs.chmodSync(readonlyFile, 0o444)
    const emptyFile = path.join(dir, 'empty.txt')
    fs.writeFileSync(emptyFile, '   \n', 'utf8')
    const subDir = path.join(dir, 'subdir')
    fs.mkdirSync(subDir)

    for (const command of [
      "cd repo && git commit -m 'x' && git push",
      "git -c user.name=x commit -m 'x'",
      "git commit --amend -m 'x'",
      "git commit --no-verify -m 'x'",
      "git commit -n -m 'x'",
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
      "git commit -F readonly.txt",
      "git commit --file=readonly.txt",
      "git commit -F empty.txt",
      "git commit -F subdir",
      "git commit -Fmessage.txt -m 'x'",
      "git commit --file=message.txt -m 'x'",
      "git commit --fi=message.txt -m 'x'",
      "git commit --template=template.txt -m 'x'",
      "git commit --edit -m 'x'",
      "git commit -e -m 'x'",
      "git commit --signoff -m 'x'",
      "git commit -s -m 'x'",
      "git commit --trailer 'DevSpec: [devspec:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]' -m 'x'",
      "git commit --trailer='Co-authored-by: Cursor <cursoragent@cursor.com>' -m 'x'",
      "git commit --trailer 'Reviewed-by: Human <human@example.com>' -m 'x'",
      "git commit --tr 'Reviewed-by: Human <human@example.com>' -m 'x'",
      "git commit --message=first -m 'second'",
      "git commit --mess=first -m 'second'",
      "git commit -mfirst -m 'second'",
      "git commit -m 'first' -m 'second'",
      "git commit -m 'first'joined",
      "git commit -m 'x' | tee out",
      "git commit -m 'x'; echo done",
      "git commit -m 'x'\necho done",
      // Ambiguous multi-line / heredoc forms:
      "git commit -F - <<MSG\nfeat: unquoted delimiter\nMSG",
      "git commit -F - <<\"MSG\"\nfeat: double-quoted delimiter\nMSG",
      "git commit -F - <<-'MSG'\n\tfeat: tab-stripped heredoc\nMSG",
      "git commit -m \"$(cat <<MSG\nfeat: unquoted substitution\nMSG\n)\"",
      "git commit -m \"$(echo <<'MSG'\nfeat: non-cat substitution\nMSG\n)\"",
      "git commit -m \"$(cat <<'MSG'\nfeat: $(whoami)\nMSG\n)\"",
      "git commit -F - <<'MSG'\nfeat: first\nMSG\ngit commit -F - <<'MSG2'\nfeat: second\nMSG2",
      "git commit -F - <<'MSG'\nfeat: trailing command\nMSG\necho done",
      "git commit --amend -F - <<'MSG'\nfeat: amend heredoc\nMSG",
    ]) assert.equal(parseReadableCommit(command, dir), null, command)
  })

  it('reads every valid full reference and flags only malformed markers', () => {
    assert.deepEqual(inspectReferences(`ship [devspec:${ITEM_A}]`), { valid: [ITEM_A], malformed: false })
    assert.equal(inspectReferences('ship [devspec:aaaaaaaa]').malformed, true)
    assert.equal(inspectReferences(`ship [devspec:${ITEM_A}`).malformed, true)
    assert.equal(inspectReferences(`ship [devspec : ${ITEM_A}]`).malformed, true)
    // A commit may name several items (contract 4.13.0, item 96f3dfb7); a repeat is one.
    assert.deepEqual(inspectReferences(`ship [devspec:${ITEM_A}] [devspec:${ITEM_B}]`), { valid: [ITEM_A, ITEM_B], malformed: false })
    assert.deepEqual(inspectReferences(`ship [devspec:${ITEM_A}] [devspec:${ITEM_A}]`), { valid: [ITEM_A], malformed: false })
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

  it('derives repository identity and the untracked pin from a real linked worktree', () => {
    const root = tempRoot()
    const home = path.join(root, 'home')
    const main = path.join(root, 'main')
    const linked = path.join(root, 'linked')
    fs.mkdirSync(main)
    execFileSync('git', ['-C', main, 'init', '-q', '-b', 'main'])
    execFileSync('git', ['-C', main, 'config', 'user.name', 'Cursor Pin Test'])
    execFileSync('git', ['-C', main, 'config', 'user.email', 'cursor-pin@example.invalid'])
    execFileSync('git', ['-C', main, 'commit', '--allow-empty', '-q', '-m', 'initial'])
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'linked', linked])
    fs.mkdirSync(path.join(main, '.devspec'))
    fs.writeFileSync(path.join(main, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))

    assert.equal(gitMainWorktree(linked), main)
    assert.deepEqual(findProjectPin(linked, { home }), {
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

describe('online reference confirmation', () => {
  function gitPinnedRepo() {
    const result = pinnedRepo()
    execFileSync('git', ['-C', result.repo, 'init', '-q', '-b', 'main'])
    execFileSync('git', ['-C', result.repo, 'config', 'user.name', 'Cursor Online Test'])
    execFileSync('git', ['-C', result.repo, 'config', 'user.email', 'cursor-online@example.invalid'])
    execFileSync('git', ['-C', result.repo, 'commit', '--allow-empty', '-q', '-m', 'initial'])
    execFileSync('git', ['-C', result.repo, 'remote', 'add', 'origin', 'git@github.com:DevSpecAI/cursor-online-test.git'])
    return result
  }

  it('validates one existing reference with target project hints and a bounded timeout', async () => {
    const { home, repo } = gitPinnedRepo()
    const stateRoot = tempRoot()
    const calls = []
    const output = await pre(`git commit -m 'ship [devspec:${ITEM_A}]'`, repo, stateRoot, {
      home,
      repoRoot: repo,
      mainWorktree: repo,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }),
      onlineCall: async (request) => { calls.push(request); return { online: { status: 'valid' } } },
    })
    assert.equal(output, null)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      mcpUrl: 'https://mcp.example/test',
      token: 'dvs_test',
      name: 'validate_commit_reference',
      arguments: {
        commit_message: `ship [devspec:${ITEM_A}]`,
        pinned_project_id: PROJECT,
        git_remote: 'git@github.com:DevSpecAI/cursor-online-test.git',
      },
      timeoutMs: ONLINE_REFERENCE_TIMEOUT_MS,
    })
  })

  it('inherits pin and remote from a real linked worktree, and signs in with the plugin’s own login', async () => {
    const root = tempRoot()
    const home = path.join(root, 'home')
    const main = path.join(root, 'main')
    const linked = path.join(root, 'linked')
    fs.mkdirSync(main)
    execFileSync('git', ['-C', main, 'init', '-q', '-b', 'main'])
    execFileSync('git', ['-C', main, 'config', 'user.name', 'Cursor Online Worktree'])
    execFileSync('git', ['-C', main, 'config', 'user.email', 'cursor-online-worktree@example.invalid'])
    execFileSync('git', ['-C', main, 'commit', '--allow-empty', '-q', '-m', 'initial'])
    execFileSync('git', ['-C', main, 'remote', 'add', 'origin', 'git@github.com:DevSpecAI/worktree-online.git'])
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'linked', linked])
    fs.mkdirSync(path.join(main, '.devspec'))
    fs.writeFileSync(path.join(main, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
    // A pasted token in the repository's Cursor MCP settings is no longer read (item 95a67ee4).
    fs.mkdirSync(path.join(main, '.cursor'))
    fs.writeFileSync(path.join(main, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { devspec: { url: 'https://staging.example/mcp', headers: { Authorization: 'Bearer dvs_main_worktree' } } },
    }))
    await saveLogin({
      mcpUrl: DEFAULT_MCP_URL,
      tokens: { accessToken: 'oat_browser_login', refreshToken: 'rt_browser_login', issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000 },
      issuer: 'https://clerk.devspec.ai',
      tokenEndpoint: 'https://clerk.devspec.ai/oauth/token',
      clientId: 'bGf2U1lPyRZDYkzY',
      resource: 'https://api.devspec.ai/api/mcp',
    }, { home })
    let request = null
    const output = await pre(`git commit -m 'ship [devspec:${ITEM_A}]'`, linked, tempRoot(), {
      home,
      env: { HOME: home },
      onlineCall: async (value) => { request = value; return { online: { status: 'valid' } } },
    })
    assert.equal(output, null)
    assert.equal(request?.token, 'oat_browser_login')
    assert.equal(request?.mcpUrl, DEFAULT_MCP_URL)
    assert.equal(request?.arguments?.pinned_project_id, PROJECT)
    assert.equal(request?.arguments?.git_remote, 'git@github.com:DevSpecAI/worktree-online.git')
  })

  it('denies only a definitive not_found with non-terminating recovery', async () => {
    const { home, repo } = gitPinnedRepo()
    const output = await pre(`git commit -m 'ship [devspec:${ITEM_A}]'`, repo, tempRoot(), {
      home, repoRoot: repo, mainWorktree: repo,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }),
      onlineCall: async () => ({ online: { status: 'not_found' } }),
    })
    assert.equal(output?.permission, 'deny')
    assert.match(output?.agent_message || '', /UUID tail|another project/i)
    assert.match(output?.agent_message || '', /retry/i)
    assert.equal(output?.continue, undefined)
    assert.equal(output?.stopReason, undefined)
  })

  it('allows every unavailable or indeterminate online outcome', async () => {
    const { home, repo } = gitPinnedRepo()
    const stateRoot = tempRoot()
    const results = [
      { online: { status: 'unavailable' } },
      { online: { status: 'indeterminate' } },
      { online: { status: 'unknown' } },
      { online: { status: ' NOT_FOUND ' } },
      { online: { status: 'Not_Found' } },
      { online: {} },
      {},
      null,
    ]
    for (const result of results) {
      assert.equal(await pre(`git commit -m 'ship [devspec:${ITEM_A}]'`, repo, stateRoot, {
        home, repoRoot: repo, mainWorktree: repo,
        resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }),
        onlineCall: async () => result,
      }), null)
    }
    assert.equal(await pre(`git commit -m 'ship [devspec:${ITEM_A}]'`, repo, stateRoot, {
      home, repoRoot: repo, mainWorktree: repo,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }),
      onlineCall: async () => { throw new Error('offline') },
    }), null)
  })

  it('lets a commit naming several valid items through, and refuses one that names an unknown item', async () => {
    const { home, repo } = gitPinnedRepo()
    const stateRoot = tempRoot()
    const message = `git commit -m 'ship [devspec:${ITEM_A}] [devspec:${ITEM_B}]'`
    const options = (references) => ({
      home, repoRoot: repo, mainWorktree: repo,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }),
      onlineCall: async () => ({ references }),
    })
    assert.equal(await pre(message, repo, stateRoot, options([
      { reference: ITEM_A, online: { status: 'valid' } },
      { reference: ITEM_B, online: { status: 'valid' } },
    ])), null)
    const refused = await pre(message, repo, stateRoot, options([
      { reference: ITEM_A, online: { status: 'valid' } },
      { reference: ITEM_B, online: { status: 'not_found' } },
    ]))
    assert.equal(refused?.permission, 'deny')
    assert.equal(refused?.agent_message, unresolvedReferenceMessage(ITEM_B))
    // An undecided reference fails open, as a single one does.
    assert.equal(await pre(message, repo, stateRoot, options([
      { reference: ITEM_A, online: { status: 'valid' } },
      { reference: ITEM_B, online: { status: 'unavailable' } },
    ])), null)
  })

  it('makes no online call without credentials, without a reference, or while stamping', async () => {
    const { home, repo } = gitPinnedRepo()
    const stateRoot = tempRoot()
    let calls = 0
    const onlineCall = async () => { calls += 1; return { online: { status: 'valid' } } }
    assert.equal(await pre(`git commit -m 'ship [devspec:${ITEM_A}]'`, repo, stateRoot, {
      home, repoRoot: repo, mainWorktree: repo, resolveAuth: () => ({ ok: false }), onlineCall,
    }), null)
    // With no task claimed the commit runs as written, and asks DevSpec nothing.
    assert.equal(pre("git commit -m 'plain'", repo, stateRoot, {
      home, repoRoot: repo, mainWorktree: repo,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }), onlineCall,
    }), null)
    assert.equal(pre(`git commit --message=hidden -m 'ship [devspec:${ITEM_A}]'`, repo, stateRoot, {
      home, repoRoot: repo, mainWorktree: repo,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }), onlineCall,
    }), null)
    observeClaim(stateRoot)
    assert.match(pre("git commit -m 'stamp me'", repo, stateRoot, {
      home, repoRoot: repo, mainWorktree: repo,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' }), onlineCall,
    })?.updated_input?.command || '', new RegExp(ITEM_A))
    assert.equal(calls, 0)
  })

  it('fails open against an unreachable endpoint within the explicit timeout', async () => {
    const started = Date.now()
    const outcome = await confirmReferenceOnline(`ship [devspec:${ITEM_A}]`, {
      cwd: process.cwd(),
      pin: { projectId: PROJECT },
      timeoutMs: 150,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'http://127.0.0.1:9/mcp' }),
    })
    assert.equal(outcome, 'unavailable')
    assert.ok(Date.now() - started < 2_000)
  })
})

describe('claim observation and commit decisions', () => {
  it('takes in a commit note whose own command never reported back, however much later the next step comes', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    // The commit ran, but its command failed afterwards: Cursor sends postToolUseFailure,
    // never this call's postToolUse.
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_use_id: 'failed-1' }), null)
    const later = Date.now() + 3 * 24 * 60 * 60 * 1000
    const out = handleHook('postToolUse', { conversation_id: 'chat-a', tool_name: 'Read', tool_use_id: 'other-2', tool_input: { file_path: '/x' } }, { stateRoot, home: stateRoot, nowMs: later })
    const id = noteIdIn(out?.additional_context)
    assert.ok(id, 'offered at the next step, three days on')
    assert.equal(readNoteText(id, { home: stateRoot }), unlinkedCommitText())
  })

  it('keeps a commit note in the state when its hand-over cannot be written, and hands it over once it can', { skip: process.getuid?.() === 0 && 'root writes anywhere' }, () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_use_id: 'plain-7' }), null)
    const notes = path.join(stateRoot, '.devspec', 'notes')
    fs.mkdirSync(notes, { recursive: true })
    fs.chmodSync(notes, 0o500)
    try {
      assert.throws(() => handleHook('postToolUse', { conversation_id: 'chat-a', tool_name: 'Shell', tool_use_id: 'plain-7' }, { stateRoot, home: stateRoot }))
    } finally {
      fs.chmodSync(notes, 0o700)
    }
    const out = handleHook('postToolUse', { conversation_id: 'chat-a', tool_name: 'Read', tool_use_id: 'next-1', tool_input: { file_path: '/x' } }, { stateRoot, home: stateRoot })
    assert.equal(readNoteText(noteIdIn(out?.additional_context), { home: stateRoot }), unlinkedCommitText(), 'still waiting, and handed over now')
  })

  it('offers a commit note after every step until the agent has read it whole, never just because it was printed', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_use_id: 'plain-9' }), null)
    const after = (input) => handleHook('postToolUse', { conversation_id: 'chat-a', ...input }, { stateRoot, home: stateRoot })?.additional_context ?? null
    const pointer = after({ tool_name: 'Shell', tool_use_id: 'plain-9' })
    const id = noteIdIn(pointer)
    assert.ok(id, 'a pointer to the note')
    assert.equal(readNoteText(id, { home: stateRoot }), unlinkedCommitText())
    // Cursor may have dropped that step's notes: the next steps offer it again.
    assert.equal(after({ tool_name: 'Read', tool_input: { file_path: '/x' } }), pointer)
    assert.equal(after({ tool_name: 'Shell', tool_input: { command: `test -e ~/.devspec/notes/${id}.md` }, tool_output: JSON.stringify({ output: '', exitCode: 0 }) }), pointer, 'mentioning it is not reading it')
    const file = noteFiles(stateRoot, id)[0]
    const whole = fs.readFileSync(file, 'utf8')
    const cut = { ...catCall(stateRoot, file, { conversation: 'chat-a' }), tool_output: JSON.stringify({ output: `${whole.slice(0, 40)}\n...\n${whole.slice(-90)}`, exitCode: 0 }) }
    assert.equal(after(cut), pointer, 'a cut read is not a read')
    assert.equal(after(catCall(stateRoot, file, { conversation: 'chat-a' })), null, 'read whole: done')
    assert.equal(after({ tool_name: 'Read', tool_input: { file_path: '/x' } }), null)
  })

  it('accepts a valid reference without any live claim, lets an unreferenced commit with no claim through with a note, and allows offline/non-commit work', async () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    assert.equal(await pre(`git commit -m 'ship [devspec:${ITEM_B}]'`, repo, stateRoot, {
      home, repoRoot: repo, mainWorktree: null, resolveAuth: () => ({ ok: false }),
    }), null)
    // No decision and no rewrite: the commit runs exactly as written.
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_use_id: 'plain-1' }), null)
    // The note reaches the agent once the command has run, once.
    assert.deepEqual(noteAfter(stateRoot, 'plain-1'), { additional_context: unlinkedCommitText() })
    assert.equal(noteAfter(stateRoot, 'plain-1'), null)
    assert.equal(pre("git commit -m 'broken [devspec:not-a-uuid]'", repo, stateRoot, { home, repoRoot: repo })?.permission, 'deny')
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_name: 'Write' }), null)
  })

  it('lets a commit through without a claim and stamps with exactly one claim across all three multi-line commit shapes', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    const msgFile = path.join(repo, 'COMMIT_MSG.txt')
    fs.writeFileSync(msgFile, 'feat: from file\n\nBody text.\n', 'utf8')

    const shapes = [
      "git commit -F - <<'MSG'\nfeat: stdin heredoc\n\nBody text.\nMSG",
      "git commit -m \"$(cat <<'MSG'\nfeat: cat substitution\n\nBody text.\nMSG\n)\"",
      'git commit -F COMMIT_MSG.txt',
    ]

    for (const cmd of shapes) {
      assert.equal(pre(cmd, repo, stateRoot, { home, repoRoot: repo }), null, `expected the commit as written without a claim for: ${cmd}`)
      assert.deepEqual(noteAfter(stateRoot), { additional_context: unlinkedCommitText() })
    }

    observeClaim(stateRoot, ITEM_A)

    for (let i = 0; i < shapes.length; i += 1) {
      const stamped = pre(shapes[i], repo, stateRoot, { home, repoRoot: repo, tool_use_id: `ml-${i}` })
      assert.equal(stamped?.permission, 'allow', `expected allow+stamp with one claim for: ${shapes[i]}`)
      assert.match(stamped?.updated_input?.command || '', new RegExp(`\\[devspec:${ITEM_A}\\]`))
      assert.match(stamped?. updated_input?.command || '', /Body text\./)
    }
  })

  it('stamps exactly one observed claim through structured preToolUse updated_input', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot)
    const output = pre("cd . && git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo, tool_use_id: 'stamp-1' })
    assert.equal(output?.permission, 'allow')
    assert.equal(output?.updated_input?.command, `cd . && git commit -m 'ship [devspec:${ITEM_A}]'`)
    assert.match(output?.agent_message || '', new RegExp(ITEM_A))
    assert.equal(readConversationState('chat-a', stateRoot).pending_stamps['stamp-1'].task_id, ITEM_A)

    const reported = handleHook('postToolUse', {
      conversation_id: 'chat-a', tool_name: 'Shell', tool_use_id: 'stamp-1', cwd: repo,
    }, { stateRoot, pinOptions: { home, repoRoot: repo } })
    assert.match(reported?.additional_context || '', new RegExp(`appended \\[devspec:${ITEM_A}\\]`))
    assert.equal(readConversationState('chat-a', stateRoot).pending_stamps['stamp-1'], undefined)
  })

  it('resets pre-cutover transient pending_stamps entries without deleting active_claims or nudged_projects', () => {
    const stateRoot = tempRoot()
    const nowIso = new Date().toISOString()
    writeConversationState('chat-migrated', {
      active_claims: [{ id: ITEM_A, project_id: PROJECT, observed_at: nowIso }],
      nudged_projects: [PROJECT],
      pending_stamps: {
        legacy_tool: { id: undefined, at: nowIso },
        current_tool: { task_id: ITEM_B, at: nowIso },
      },
    }, stateRoot)
    const state = readConversationState('chat-migrated', stateRoot)
    assert.deepEqual(state.active_claims.map((claim) => claim.id), [ITEM_A])
    assert.deepEqual(state.nudged_projects, [PROJECT])
    assert.deepEqual(Object.keys(state.pending_stamps), ['current_tool'])
    assert.equal(state.pending_stamps.current_tool.task_id, ITEM_B)
  })

  it('never overwrites an existing different reference', async () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    assert.equal(await pre(`git commit -m 'follow-up [devspec:${ITEM_B}]'`, repo, stateRoot, {
      home, repoRoot: repo, mainWorktree: null, resolveAuth: () => ({ ok: false }),
    }), null)
  })

  it('never stamps a claim observed for a different DevSpec project', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    handleHook('afterMCPExecution', mcp(
      'claim_work_item',
      { claim_success: true, project_id: '99999999-8888-7777-6666-555555555555', id: ITEM_A },
      { task_id: ITEM_A },
    ), { stateRoot })
    // Not this project's claim, so none is claimed here: the commit runs as written.
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo }), null)
    assert.deepEqual(noteAfter(stateRoot), { additional_context: unlinkedCommitText() })
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
    assert.equal(malformed?.agent_message, MALFORMED_REFERENCE_MESSAGE)
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
    handleHook('afterMCPExecution', mcp('record_implementation', { status: 'implemented' }, { task_id: ITEM_A }), { stateRoot })
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((claim) => claim.id), [ITEM_B])
    handleHook('afterMCPExecution', mcp('record_implementation', { error: 'not recorded' }, { task_id: ITEM_B }), { stateRoot })
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((claim) => claim.id), [ITEM_B])
  })

  it('expires stale claim observations and never stamps legacy timeless state', () => {
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
  it('injects at most one postToolUse nudge per conversation/project on agent-visible channels without promising refusal or pointing at the analyser', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    const first = handleHook('postToolUse', {
      conversation_id: 'chat-a', tool_name: 'Write', tool_use_id: 'edit-1', cwd: repo,
      tool_input: { path: path.join(repo, 'src', 'one.ts') },
    }, { stateRoot, pinOptions: { home, repoRoot: repo } })
    assert.match(first?.additional_context || '', /edit already completed/i)
    assert.equal(first?.agent_message, first?.additional_context)
    assert.match(first?.agent_message || '', /search_tasks|create_task/)
    // The smallest adequate task, never a thin one, and no tag to type: with one claim
    // the hook appends it (item 8f047489).
    assert.match(first?.agent_message || '', /smallest adequate task/)
    assert.match(first?.agent_message || '', /claim_work_item/)
    assert.match(first?.agent_message || '', /added to the commit message for you/)
    assert.doesNotMatch(first?.agent_message || '', /thin|last-mile|<full-uuid>/i)
    // When a task is warranted is the served contract's, not this message's.
    assert.match(first?.agent_message || '', /work_entry_contract/)
    // So is how to write the new task's intent (item 95e4f277).
    assert.match(first?.agent_message || '', /core\.write-the-persons-intent/)
    assert.doesNotMatch(first?.agent_message || '', /refused|reconciliation|analy[sz]er/i)
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
  it('parses hook JSON and requires explicit matching claim success under the Tasks contract', () => {
    assert.deepEqual(parseHookInput('{"conversation_id":"chat-a"}'), { conversation_id: 'chat-a' })
    assert.deepEqual(parseHookInput('broken'), {})
    assert.equal(parseMcpExecution(mcp('devspec__claim_work_item', {
      claim_success: true, project_id: PROJECT.toUpperCase(), id: ITEM_A.toUpperCase(),
    }, { task_id: ITEM_A, pinned_project_id: PROJECT })).successful, true)
    assert.equal(parseMcpExecution(mcp('devspec__claim_work_item', {
      claim_success: true, task: { id: ITEM_A, project_id: PROJECT, status: 'active' },
    }, { task_id: ITEM_A })).successful, true)
    assert.equal(parseMcpExecution(mcp('devspec__claim_work_item', {
      claim_success: true, data: { task: { id: ITEM_A, project_id: PROJECT } },
    }, { task_id: ITEM_A })).successful, true)
    // The real response names no project: the claim counts in the project the call named, and nowhere without one.
    const real = parseMcpExecution(mcp('devspec__claim_work_item', claimResponse(ITEM_A), { task_id: ITEM_A, project_id: PROJECT }))
    assert.equal(real.successful, true)
    assert.equal(real.projectId, PROJECT)
    // A notice DevSpec appends after its answer does not hide the answer.
    const noticed = parseMcpExecution(mcp('devspec__claim_work_item', envelope(claimResponse(ITEM_A), PLUGIN_NOTICE), { task_id: ITEM_A, project_id: PROJECT }))
    assert.equal(noticed.successful, true)
    assert.equal(noticed.projectId, PROJECT)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, id: ITEM_A }, { task_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', claimResponse(ITEM_A), { task_id: ITEM_A, pinned_project_id: PROJECT })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { ...claimResponse(ITEM_A), claim_success: false }, { task_id: ITEM_A, project_id: PROJECT })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { ok: true, project_id: PROJECT, id: ITEM_A }, { task_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('other__claim_work_item', { claim_success: true, project_id: PROJECT, id: ITEM_A }, { task_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, project_id: PROJECT, id: ITEM_B }, { task_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, project_id: PROJECT, id: ITEM_A }, {
      task_id: ITEM_A, project_id: '99999999-8888-7777-6666-555555555555',
    })).successful, false)
    assert.equal(parseMcpExecution(mcp('claim_work_item', { claim_success: true, project_id: 'invalid', id: ITEM_A }, { task_id: ITEM_A })).successful, false)
    assert.equal(parseMcpExecution(mcp('record_implementation', { task: { lifecycle: 'done' } }, { task_id: ITEM_A })).successful, true)
    assert.equal(parseMcpExecution({ tool_name: 'claim_work_item', tool_input: '{}', result_json: 'broken' }).successful, false)
  })
})


describe('a claim whose result Cursor withheld (item ef54cfcb)', () => {
  // Recorded live on cursor-agent 2026.10.22: a successful claim's ~52 KB result reached
  // afterMCPExecution as one empty text block, the model reading it from a file instead.
  const withheld = { content: [{ type: 'text', text: '' }], isError: false }
  const auth = () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' })
  const claimCall = (conversationId = 'chat-a') => ({
    ...mcp('devspec__claim_work_item', withheld, { task_id: ITEM_A, project_id: PROJECT, local_session_id: conversationId }, conversationId),
    workspace_roots: ['/work/repo'],
  })

  it('records the claim once DevSpec confirms this conversation holds it', async () => {
    const stateRoot = tempRoot()
    const requests = []
    await handleHook('afterMCPExecution', claimCall(), {
      stateRoot,
      resolveAuth: auth,
      onlineCall: async (request) => {
        requests.push(request)
        return { id: ITEM_A, agent_activity: 'implementing', local_session_id: 'chat-a' }
      },
    })
    assert.deepEqual(requests.map((r) => [r.name, r.arguments]), [['get_task', { task_id: ITEM_A, project_id: PROJECT }]])
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((c) => [c.id, c.project_id]), [[ITEM_A, PROJECT]])
    assert.deepEqual(readConversationState('chat-a', stateRoot).unrecorded_claims, [])
  })

  it('records nothing when DevSpec shows another conversation holds it, or nobody does', async () => {
    for (const answer of [
      async () => ({ id: ITEM_A, agent_activity: 'implementing', local_session_id: 'chat-elsewhere' }),
      async () => ({ id: ITEM_A, agent_activity: 'idle', local_session_id: 'chat-a' }),
    ]) {
      const stateRoot = tempRoot()
      await handleHook('afterMCPExecution', claimCall(), { stateRoot, resolveAuth: auth, onlineCall: answer })
      const state = readConversationState('chat-a', stateRoot)
      assert.deepEqual(state.active_claims, [])
      assert.deepEqual(state.unrecorded_claims, [])
    }
  })

  it('keeps the claim as unrecorded, never as no claim, when DevSpec cannot be asked or cannot answer', async () => {
    for (const [resolveAuth, onlineCall] of [
      [auth, async () => { throw new Error('offline') }],
      [() => ({ ok: false }), async () => ({})],
      [auth, async () => ({ raw: 'not a task' })],
    ]) {
      const stateRoot = tempRoot()
      await handleHook('afterMCPExecution', claimCall(), { stateRoot, resolveAuth, onlineCall })
      const state = readConversationState('chat-a', stateRoot)
      assert.deepEqual(state.active_claims, [])
      assert.deepEqual(state.unrecorded_claims.map((e) => [e.requested, e.task_id, e.project_id, e.confirmed]), [[ITEM_A, ITEM_A, PROJECT, false]])
    }
  })

  it('never asks DevSpec about a claim Cursor reported as refused', async () => {
    const stateRoot = tempRoot()
    let asked = false
    const refused = { content: [{ type: 'text', text: 'Claim failed: item is already claimed.' }], isError: true }
    await handleHook('afterMCPExecution', mcp('devspec__claim_work_item', refused, { task_id: ITEM_A, project_id: PROJECT }), {
      stateRoot,
      resolveAuth: auth,
      onlineCall: async () => { asked = true; return {} },
    })
    assert.equal(asked, false)
    const state = readConversationState('chat-a', stateRoot)
    assert.deepEqual(state.active_claims, [])
    assert.deepEqual(state.unrecorded_claims, [])
  })
})

describe('a claim made by short code (item 953ab72e)', () => {
  const SHORT = ITEM_A.slice(0, 8)
  const auth = () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' })

  it('is recorded against the full id DevSpec names, and the next commit is tagged with it', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    handleHook('afterMCPExecution', mcp('devspec__claim_work_item', envelope(claimResponse(ITEM_A)), { task_id: SHORT, project_id: PROJECT }), { stateRoot })
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((c) => [c.id, c.project_id]), [[ITEM_A, PROJECT]])
    assert.match(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo })?.updated_input?.command || '', new RegExp(`\\[devspec:${ITEM_A}\\]`))
    // An answer naming a task the short code does not begin is not this claim.
    assert.equal(parseMcpExecution(mcp('devspec__claim_work_item', claimResponse(ITEM_B), { task_id: SHORT, project_id: PROJECT })).successful, false)
  })

  it('is resolved through DevSpec when Cursor withheld the result', async () => {
    const stateRoot = tempRoot()
    const requests = []
    await handleHook('afterMCPExecution', mcp('devspec__claim_work_item', { content: [{ type: 'text', text: '' }], isError: false }, { task_id: SHORT, project_id: PROJECT }), {
      stateRoot,
      resolveAuth: auth,
      onlineCall: async (request) => {
        requests.push(request.arguments)
        return { id: ITEM_A, agent_activity: 'implementing', local_session_id: 'chat-a' }
      },
    })
    assert.deepEqual(requests, [{ task_id: SHORT, project_id: PROJECT }])
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((c) => c.id), [ITEM_A])
  })

  it('is released by its short code', () => {
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    observeClaim(stateRoot, ITEM_B)
    handleHook('afterMCPExecution', mcp('devspec__release_work_item', { released: true }, { task_id: SHORT }), { stateRoot })
    assert.deepEqual(readConversationState('chat-a', stateRoot).active_claims.map((c) => c.id), [ITEM_B])
  })
})

describe('a claim that could not be recorded never lends the commit an older claim (item 953ab72e)', () => {
  const auth = () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://mcp.example/test' })
  const withheldClaim = (args) => mcp('devspec__claim_work_item', { content: [{ type: 'text', text: '' }], isError: false }, args)
  const holds = async (request) => ({ id: request.arguments.task_id, agent_activity: 'implementing', local_session_id: 'chat-a' })

  it('lets the commit through untagged, with a note, when DevSpec could not confirm the claim', async () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    await handleHook('afterMCPExecution', withheldClaim({ task_id: ITEM_B, project_id: PROJECT }), {
      stateRoot, resolveAuth: auth, onlineCall: async () => { throw new Error('offline') },
    })
    // Not tagged with ITEM_A, the older claim, and not stopped.
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo }), null)
    const note = noteAfter(stateRoot)?.additional_context
    assert.equal(note, unrecordedCommitText())
  })

  it('stops the commit to ask which task, naming both, when DevSpec confirmed a claim it could not record and the repository is the project\'s', async () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    // Claimed with no project: DevSpec confirms it, but the plugin cannot tell whose it is.
    await handleHook('afterMCPExecution', withheldClaim({ task_id: ITEM_B }), { stateRoot, resolveAuth: auth, onlineCall: holds })
    assert.deepEqual(readConversationState('chat-a', stateRoot).unrecorded_claims.map((e) => [e.task_id, e.project_id, e.confirmed]), [[ITEM_B, null, true]])
    const stopped = pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo })
    assert.equal(stopped?.permission, 'deny')
    assert.equal(stopped?.agent_message, unrecordedClaimText([ITEM_A], [ITEM_B]))
    assert.match(stopped.agent_message, new RegExp(`\\[devspec:${ITEM_B}\\], \\[devspec:${ITEM_A}\\]`))
    assert.equal(stopped?.updated_input, undefined)
    // The agent's own reference goes through.
    assert.equal(await pre(`git commit -m 'ship [devspec:${ITEM_B}]'`, repo, stateRoot, { home, repoRoot: repo, mainWorktree: null, resolveAuth: () => ({ ok: false }) }), null)
  })

  it('a visible successful claim with no project is the same: confirmed, so the commit asks', () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    handleHook('afterMCPExecution', mcp('devspec__claim_work_item', envelope(claimResponse(ITEM_B)), { task_id: ITEM_B }), { stateRoot })
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo })?.agent_message, unrecordedClaimText([], [ITEM_B]))
  })

  it('lets the commit through untagged, with a note, when the repository is not certainly the project\'s', async () => {
    // The project is only the conversation's choice: no pin, and an origin DevSpec did not list.
    const root = tempRoot()
    const projectHome = path.join(root, 'home')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['-C', repo, 'init', '-q'])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:someone/else.git'])
    selectProjectContext('chat-a', 'https://devspec.test/api/mcp', { id: PROJECT, name: 'App', organization: { id: PROJECT, name: 'Org' } }, 'conversation', projectHome)
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    await handleHook('afterMCPExecution', withheldClaim({ task_id: ITEM_B }), { stateRoot, resolveAuth: auth, onlineCall: holds })
    const output = handleHook('preToolUse', {
      conversation_id: 'chat-a', tool_name: 'Shell', tool_input: { command: "git commit -m 'ship'" }, tool_use_id: 'tool-1', cwd: repo,
    }, { stateRoot, projectHome, home: projectHome, pinOptions: { home: projectHome, repoRoot: repo }, prepareStandIn: () => null })
    assert.equal(output, null)
    assert.equal(noteAfter(stateRoot)?.additional_context, unrecordedCommitText())
  })

  it('still stops on several recorded claims when an unconfirmed one is outstanding', async () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    observeClaim(stateRoot, ITEM_B)
    await handleHook('afterMCPExecution', withheldClaim({ task_id: 'cccccccc' , project_id: PROJECT }), {
      stateRoot, resolveAuth: auth, onlineCall: async () => { throw new Error('offline') },
    })
    assert.equal(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo })?.agent_message, MULTIPLE_CLAIMS_MESSAGE)
  })

  it('clears once the claim is recorded or the task is released, and tagging resumes', async () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    observeClaim(stateRoot, ITEM_A)
    await handleHook('afterMCPExecution', withheldClaim({ task_id: ITEM_B, project_id: PROJECT }), {
      stateRoot, resolveAuth: auth, onlineCall: async () => { throw new Error('offline') },
    })
    handleHook('afterMCPExecution', mcp('devspec__release_work_item', { released: true }, { task_id: ITEM_B }), { stateRoot })
    assert.deepEqual(readConversationState('chat-a', stateRoot).unrecorded_claims, [])
    assert.match(pre("git commit -m 'ship'", repo, stateRoot, { home, repoRoot: repo })?.updated_input?.command || '', new RegExp(ITEM_A))

    await handleHook('afterMCPExecution', withheldClaim({ task_id: ITEM_B, project_id: PROJECT }), {
      stateRoot, resolveAuth: auth, onlineCall: async () => { throw new Error('offline') },
    })
    await handleHook('afterMCPExecution', withheldClaim({ task_id: ITEM_B, project_id: PROJECT }), { stateRoot, resolveAuth: auth, onlineCall: holds })
    const state = readConversationState('chat-a', stateRoot)
    assert.deepEqual(state.unrecorded_claims, [])
    assert.deepEqual(state.active_claims.map((c) => c.id).sort(), [ITEM_A, ITEM_B])
  })

  it('suppresses the no-claim edit reminder while a claim is unrecorded', async () => {
    const { home, repo } = pinnedRepo()
    const stateRoot = tempRoot()
    await handleHook('afterMCPExecution', withheldClaim({ task_id: ITEM_B, project_id: PROJECT }), {
      stateRoot, resolveAuth: auth, onlineCall: async () => { throw new Error('offline') },
    })
    assert.equal(handleHook('postToolUse', {
      conversation_id: 'chat-a', tool_name: 'Write', cwd: repo, tool_input: { path: path.join(repo, 'src', 'one.ts') },
    }, { stateRoot, pinOptions: { home, repoRoot: repo } }), null)
  })
})

describe('the notes beside a commit that went through untagged', () => {
  it('say how to link the next commit and name no internal rule', () => {
    for (const note of [unlinkedCommitText(), unrecordedCommitText()]) {
      assert.match(note, /It was not stopped\./)
      assert.match(note, /\[devspec:<uuid>\]/)
      assert.match(note, /if it needs no task, there is nothing to do/)
      assert.doesNotMatch(note, /_contract|devspec:\/\/|\bcore\.|\bsemantics\./)
    }
    assert.match(unlinkedCommitText(), /claim_work_item/)
  })
})
