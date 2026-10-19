#!/usr/bin/env node
/**
 * After an agent gives a pinned folder its repository, the person is told where to link
 * it (item fa9b809b). Run: node --test hooks/scripts/repo-link-nudge.test.mjs
 *
 * The failure worth guarding is a false statement: telling someone their repository is
 * unlinked when it is linked, when the server could not be asked, or about a project
 * they cannot open. Silence is always the safe answer.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { handleBashPost, looksRemoteCreating, nudgeText } from './repo-link-nudge.mjs'

const tmp = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmp.push(dir)
  return dir
}
after(() => {
  for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true })
})

const PROJECT = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const REMOTE = 'https://github.com/example/greenfield.git'

/** One hook call with every outside effect stubbed; returns the output and the calls. */
async function run({
  command = `git remote add origin ${REMOTE}`,
  pin = { project_id: PROJECT, path: '/x/.devspec/project.json' },
  remote = REMOTE,
  auth = { ok: true, token: 'dvs_test', mcp_url: 'http://127.0.0.1:1/api/mcp' },
  listed = {
    projects: [{ id: PROJECT, name: 'Greenfield' }],
    remote_match: { normalized: 'github.com/example/greenfield', resolved_project_id: null, candidate_project_ids: [] },
  },
  sessionId = 'conv-1',
  stateDir = tmpDir('devspec-nudge-state-'),
} = {}) {
  const calls = []
  const out = await handleBashPost(
    { conversation_id: sessionId, session_id: sessionId, cwd: '/x', tool_input: { command } },
    {
      env: { DEVSPEC_CURSOR_PROVENANCE_STATE_DIR: stateDir },
      findProjectPin: () => pin,
      gitRemoteOrigin: () => remote,
      resolveAuth: () => auth,
      readProject: () => null,
      call: async (req) => {
        calls.push(req)
        if (listed instanceof Error) throw listed
        return listed
      },
    },
  )
  return { out, calls, stateDir }
}

describe('which commands are worth a look', () => {
  it('matches the ways an agent gives a folder its origin', () => {
    for (const command of [
      `git remote add origin ${REMOTE}`,
      `cd app && git remote add origin ${REMOTE}`,
      `git -C app remote set-url origin ${REMOTE}`,
      'gh repo create greenfield --private --source=. --remote=origin --push',
    ]) {
      assert.equal(looksRemoteCreating(command), true, command)
    }
  })

  it('ignores reads and everything else', () => {
    for (const command of ['git remote -v', 'git remote get-url origin', 'git push -u origin main', 'ls', '', null]) {
      assert.equal(looksRemoteCreating(command), false, String(command))
    }
  })
})

describe('the reminder', () => {
  it('is said when the new remote does not resolve to the pinned project', async () => {
    const { out, calls } = await run()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'list_projects')
    assert.deepEqual(calls[0].arguments, { git_remote: REMOTE })
    const text = out?.hookSpecificOutput?.additionalContext
    assert.equal(out?.hookSpecificOutput?.hookEventName, 'PostToolUse')
    assert.equal(out?.additional_context, text)
    assert.match(text, /"Greenfield"/)
    assert.match(text, /Settings → Integrations → Repositories/)
    assert.ok(text.includes(REMOTE))
    assert.doesNotMatch(text, new RegExp(PROJECT), 'the person needs the name, not our id')
  })

  it('is said once per conversation, project and remote', async () => {
    const stateDir = tmpDir('devspec-nudge-once-')
    assert.ok((await run({ stateDir })).out)
    const again = await run({ stateDir })
    assert.equal(again.out, null)
    assert.equal(again.calls.length, 0, 'the second time it does not even ask')
    assert.ok((await run({ stateDir, sessionId: 'conv-2' })).out, 'a new conversation hears it once too')
  })

  it('stays silent when the repository already resolves to the pinned project', async () => {
    const { out } = await run({
      listed: { projects: [{ id: PROJECT, name: 'Greenfield' }], remote_match: { resolved_project_id: PROJECT, candidate_project_ids: [] } },
    })
    assert.equal(out, null)
  })

  it('stays silent when the pinned project is one of several the repository resolves to', async () => {
    const { out } = await run({
      listed: { projects: [{ id: PROJECT, name: 'Greenfield' }], remote_match: { resolved_project_id: null, candidate_project_ids: ['other', PROJECT] } },
    })
    assert.equal(out, null)
  })

  it('stays silent about a project this key cannot see', async () => {
    const { out } = await run({ listed: { projects: [{ id: 'someone-else', name: 'X' }], remote_match: { resolved_project_id: null } } })
    assert.equal(out, null)
  })

  it('stays silent when the server cannot be asked or answers oddly', async () => {
    assert.equal((await run({ listed: new Error('fetch failed') })).out, null)
    assert.equal((await run({ listed: { projects: [] } })).out, null, 'no remote_match: no opinion')
    assert.equal((await run({ auth: { ok: false } })).out, null)
  })

  it('never asks the server outside a pinned folder, or when there is still no origin', async () => {
    const noPin = await run({ pin: null })
    assert.equal(noPin.out, null)
    assert.equal(noPin.calls.length, 0)
    const noRemote = await run({ remote: null })
    assert.equal(noRemote.out, null)
    assert.equal(noRemote.calls.length, 0)
    const unrelated = await run({ command: 'npm test' })
    assert.equal(unrelated.out, null)
    assert.equal(unrelated.calls.length, 0)
  })

  it('falls back to a generic name when the project has none', () => {
    assert.match(nudgeText({ projectName: null, remote: REMOTE }), /its DevSpec project/)
  })
})
