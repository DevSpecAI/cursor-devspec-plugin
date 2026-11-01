#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, test } from 'node:test'
import { boundConnection, commitRepoDir, handleBashPre, handleBashPost, inJurisdiction } from './commit-observation.mjs'

const SESSION = 'observation-session-1'
const PROJECT = '22222222-2222-4222-8222-222222222222'
let sandbox, repo
const state = { connection_id: '11111111-1111-4111-8111-111111111111', mcp_url: 'https://example.invalid/api/mcp', token: 'fixture-secret', connection_capability: 'fixture-capability' }
const connection = () => state
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function init(dir) {
  fs.mkdirSync(dir, { recursive: true }); git(['init', '-q'], dir)
  git(['config', 'user.email', 'fixture@example.invalid'], dir); git(['config', 'user.name', 'Fixture'], dir)
  fs.mkdirSync(path.join(dir, '.devspec'))
  fs.writeFileSync(path.join(dir, '.devspec/project.json'), JSON.stringify({ project_id: PROJECT }))
}
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-test-')); repo = path.join(sandbox, 'repo'); init(repo)
  git(['commit', '--allow-empty', '-q', '-m', 'base'])
  process.env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR = path.join(sandbox, 'state')
})
afterEach(() => { delete process.env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR; fs.rmSync(sandbox, { recursive: true, force: true }) })
const event = (command, id = 'tool-1', cwd = repo) => ({ conversation_id: SESSION, session_id: SESSION, tool_name: 'Shell', tool_use_id: id, cwd, tool_input: { command } })
const pre = (input, options = {}) => handleBashPre(input, { boundConnection: connection, ...options })
async function post(input, options = {}) {
  const calls = []
  assert.equal(await handleBashPost(input, { boundConnection: connection, call: async value => { calls.push(value) }, ...options }), null)
  return calls
}
async function run(command, { cwd = repo, id = 'tool-1' } = {}) {
  const input = event(command, id, cwd); pre(input)
  const result = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return post({ ...input, tool_response: { stdout: result.stdout, stderr: result.stderr, exit_code: result.status } })
}

for (const command of ['git commit --allow-empty -m "new"', 'git commit --allow-empty -q -m "new"', "git commit --allow-empty -q -F - <<'MSG'\nnew\n\nbody\nMSG", 'git commit --allow-empty -m "$(cat <<\'MSG\'\nnew\n\nbody\nMSG\n)"']) {
  test(`direct creation: ${command.split('\n')[0]}`, async () => {
    const calls = await run(command)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'report_commit_provenance')
    assert.equal(calls[0].arguments.commit_sha, git(['rev-parse', 'HEAD']))
    assert.equal(calls[0].arguments.pinned_project_id, PROJECT)
    assert.match(calls[0].arguments.observation_id, /^[0-9a-f-]{36}$/)
    assert.equal(calls[0].connectionCapability, state.connection_capability)
  })
}

test('root commit is distinct from a missing pre observation', async () => {
  const fresh = path.join(sandbox, 'fresh'); init(fresh)
  assert.equal((await run('git commit --allow-empty -q -m "root"', { cwd: fresh })).length, 1)
  assert.equal((await post(event('git commit --allow-empty -q -m "root"', 'no-pre', fresh))).length, 0)
})

for (const form of ['cd', '-C', 'both']) {
  test(`linked worktree with spaces: ${form}`, async () => {
    const wt = path.join(sandbox, 'linked worktree'); git(['worktree', 'add', '-qb', 'topic', wt])
    fs.mkdirSync(path.join(wt, 'nested'))
    const command = form === 'cd' ? `cd '${wt}' && git commit --allow-empty -q -m 'worktree'`
      : form === '-C' ? `git -C '${wt}' commit --allow-empty -q -m 'worktree'`
      : `cd '${sandbox}' && git -C 'linked worktree' -C nested commit --allow-empty -q -m 'worktree'`
    const calls = await run(command)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].arguments.commit_sha, git(['rev-parse', 'HEAD'], wt))
    assert.equal(calls[0].arguments.branch, 'topic')
    assert.equal(calls[0].arguments.pinned_project_id, PROJECT)
  })
}

test('single staging prefix remains readable', async () => {
  fs.writeFileSync(path.join(repo, 'a'), 'a')
  assert.equal((await run('git add a && git commit -q -m "staged"')).length, 1)
})

test('failed commit, replay, and malformed envelopes report nothing', async () => {
  const input = event('git commit -q -m "nothing staged"'); pre(input)
  const failed = spawnSync('git', ['commit', '-q', '-m', 'nothing staged'], { cwd: repo })
  assert.notEqual(failed.status, 0)
  assert.equal((await post({ ...input, tool_response: { exit_code: failed.status } })).length, 0)
  assert.equal((await post(input)).length, 0)
  assert.equal((await post(null)).length, 0)
  assert.equal(handleBashPre(null), null)
})

test('posts consume only their matching tool marker', async () => {
  const input = event('git commit --allow-empty -q -m "new"'); pre(input)
  git(['commit', '--allow-empty', '-qm', 'new'])
  assert.equal((await post({ ...input, tool_use_id: 'different-tool' })).length, 0)
  assert.equal((await post(input)).length, 1)
  assert.equal((await post(input)).length, 0)
})

test('overlapping commands never attribute the intervening commit to the stale pre marker', async () => {
  const a = event('git commit --allow-empty -q -m "a"', 'a'); const b = event('git commit --allow-empty -q -m "b"', 'b')
  pre(a); pre(b); git(['commit', '--allow-empty', '-qm', 'a']); git(['commit', '--allow-empty', '-qm', 'b'])
  assert.equal((await post(a)).length, 0); assert.equal((await post(b)).length, 0)
})

test('missing live binding, expired markers, and duplicate bonds are unknown', async () => {
  const input = event('git commit --allow-empty -q -m "new"')
  pre(input, { now: Date.now() - 11 * 60_000 }); git(['commit', '--allow-empty', '-qm', 'new'])
  assert.equal((await post(input)).length, 0)
  pre(input, { boundConnection: () => null }); git(['commit', '--allow-empty', '-qm', 'new'])
  assert.equal((await post(input)).length, 0)
  const dir = path.join(sandbox, 'connections'); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ ...state, enabled: true, local_id: SESSION }))
  assert.equal(boundConnection(SESSION, dir).connection_id, state.connection_id)
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...state, connection_id: 'other', enabled: true, local_id: SESSION }))
  assert.equal(boundConnection(SESSION, dir), null)
  assert.equal(boundConnection('different-session', dir), null)
})

for (const change of ['token', 'mcp_url', 'connection_capability', 'project_id']) {
  test(`changed ${change} never rebinds observation`, async () => {
    const input = event('git commit --allow-empty -q -m "new"'); pre(input); git(['commit', '--allow-empty', '-qm', 'new'])
    assert.equal((await post(input, { boundConnection: () => ({ ...state, [change]: 'changed' }) })).length, 0)
  })
}

test('changed repository binding and credential-bearing remotes never report', async () => {
  const input = event('git commit --allow-empty -q -m "new"'); pre(input)
  git(['commit', '--allow-empty', '-qm', 'new']); git(['remote', 'add', 'origin', 'https://github.com/another/repo.git'])
  assert.equal((await post(input)).length, 0)
  git(['remote', 'set-url', 'origin', 'https://user:secret@github.com/another/repo.git'])
  pre(input); git(['commit', '--allow-empty', '-qm', 'new'])
  assert.equal((await post(input)).length, 0)
})

test('credential-free remote is frozen and sent for server repository verification', async () => {
  git(['remote', 'add', 'origin', 'git@github.com:fixture/repo.git'])
  const calls = await run('git commit --allow-empty -q -m "new"')
  assert.equal(calls.length, 1); assert.equal(calls[0].arguments.git_remote, 'git@github.com:fixture/repo.git')
})

test('markers do not retain credentials, command text, or arbitrary output', async () => {
  pre(event('git commit --allow-empty -q -m "private message"'))
  const file = fs.readdirSync(process.env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR)[0]
  const text = fs.readFileSync(path.join(process.env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR, file), 'utf8')
  for (const secret of [state.token, state.connection_capability, 'private message', 'git commit']) assert.equal(text.includes(secret), false)
  assert.equal(fs.statSync(path.join(process.env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR, file)).mode & 0o777, 0o600)
})

test('unmarked repository and config-only unknown scope do not report', async () => {
  fs.rmSync(path.join(repo, '.devspec'), { recursive: true })
  assert.equal(inJurisdiction(repo), false)
  assert.equal((await run('git commit --allow-empty -q -m "unmarked"')).length, 0)
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { devspec: { url: state.mcp_url } } }))
  assert.equal((await run('git commit --allow-empty -q -m "unscoped"')).length, 0)
})

for (const command of ['git commit --allow-empty --amend -m "rewrite"', 'git commit --allow-empty -m "new" && git commit --allow-empty -m "second"', 'git -c alias.save=commit save --allow-empty -m "alias"', 'git commit --allow-empty -m "new" & wait']) {
  test(`unsupported operation stays fail-open: ${command}`, async () => {
    assert.equal((await run(command)).length, 0)
  })
}

test('post-commit hook moving HEAD invalidates causal proof', async () => {
  const hook = path.join(repo, '.git/hooks/post-commit')
  fs.writeFileSync(hook, '#!/bin/sh\ngit reset --soft HEAD~1\n', { mode: 0o755 })
  assert.equal((await run('git commit --allow-empty -q -m "new"')).length, 0)
})

test('offline reports never throw or change Git success', async () => {
  const input = event('git commit --allow-empty -q -m "new"'); pre(input); git(['commit', '--allow-empty', '-qm', 'new'])
  let attempts = 0
  await post(input, { call: async () => { attempts++; throw new Error('offline') } })
  assert.equal(attempts, 1)
  assert.equal(git(['show', '-s', '--format=%s', 'HEAD']), 'new')
})

test('advisory nudge keeps its existing directory helper', () => {
  assert.equal(commitRepoDir('cd "/tmp/a b" && git commit -m "x"', '/fallback'), '/tmp/a b')
  assert.equal(commitRepoDir('git -C /tmp/wt commit -m "x"', '/fallback'), '/tmp/wt')
  assert.equal(commitRepoDir(undefined, '/fallback'), '/fallback')
})
