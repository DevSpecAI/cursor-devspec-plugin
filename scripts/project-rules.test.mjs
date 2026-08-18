import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { hasGitMetadata } from '../src/project-rules-core.cjs'

const marker = /<!-- devspec-autopilot-rules:(\d+) -->/
const bundled = fs.readFileSync(new URL('../rules/devspec.mdc', import.meta.url), 'utf8')

function rulesVersion(content) {
  const match = content.match(marker)
  return match ? Number(match[1]) : null
}

function shouldUpgrade(existing, latest) {
  const installedVersion = rulesVersion(existing)
  const latestVersion = rulesVersion(latest)
  return installedVersion !== null && latestVersion !== null && latestVersion > installedVersion
}

describe('managed Cursor rule upgrade', () => {
  it('accepts both .git directories and worktree gitdir pointer files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-rules-'))
    try {
      fs.mkdirSync(path.join(root, 'directory-checkout', '.git'), { recursive: true })
      fs.mkdirSync(path.join(root, 'worktree-checkout'), { recursive: true })
      fs.writeFileSync(path.join(root, 'worktree-checkout', '.git'), 'gitdir: /repo/.git/worktrees/test\n')
      fs.mkdirSync(path.join(root, 'not-a-checkout'), { recursive: true })
      assert.equal(await hasGitMetadata(path.join(root, 'directory-checkout')), true)
      assert.equal(await hasGitMetadata(path.join(root, 'worktree-checkout')), true)
      assert.equal(await hasGitMetadata(path.join(root, 'not-a-checkout')), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('bumps the managed marker so existing v5 installs upgrade', () => {
    assert.equal(rulesVersion(bundled), 6)
    assert.equal(shouldUpgrade('<!-- devspec-autopilot-rules:5 -->\nold', bundled), true)
    assert.equal(shouldUpgrade(bundled, bundled), false)
    assert.equal(shouldUpgrade('# user-owned rules', bundled), false)
  })

  it('points to the served canonical contract and states the native-edit limit honestly', () => {
    assert.match(bundled, /claim_work_item.*returns the current product implementation contract/i)
    assert.match(bundled, /after it occurred/i)
    assert.match(bundled, /does not claim to have prevented or reverted/i)
    assert.match(bundled, /do not provide full mechanical enforcement for native edits/i)
    assert.match(bundled, /GIT_OPTIONAL_LOCKS=0/)
    assert.match(bundled, /disable external diff and text conversion/i)
  })
})
