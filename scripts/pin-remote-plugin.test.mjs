#!/usr/bin/env node
/**
 * Run: node --test scripts/pin-remote-plugin.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'
import {
  buildPluginPinBlock,
  pinRemotePluginInPrompt,
  promptAlreadyHasPluginPin,
  promptNeedsRemotePluginPin,
  resolveCursorDevspecExtensionPath,
} from './pin-remote-plugin.mjs'

describe('promptNeedsRemotePluginPin', () => {
  it('detects remote-control skill prompts', () => {
    assert.equal(promptNeedsRemotePluginPin('Run the `devspec.remote` skill'), true)
    assert.equal(promptNeedsRemotePluginPin('devspec.remote-stop'), true)
    assert.equal(
      promptNeedsRemotePluginPin('register_connection then attach_connection'),
      true,
    )
  })

  it('ignores unrelated work prompts', () => {
    assert.equal(promptNeedsRemotePluginPin('Run the `devspec.work` skill'), false)
  })
})

describe('promptAlreadyHasPluginPin', () => {
  it('detects an existing PLUGIN= line', () => {
    assert.equal(
      promptAlreadyHasPluginPin('PLUGIN=C:\\ext\n\nRun the skill'),
      true,
    )
    assert.equal(promptAlreadyHasPluginPin('Run the skill'), false)
  })
})

describe('pinRemotePluginInPrompt', () => {
  /** @type {string} */
  let tmpHome
  /** @type {string} */
  let extensionPath

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-pin-'))
    extensionPath = path.join(
      tmpHome,
      '.cursor',
      'extensions',
      'devspecai.devspec-autopilot-0.4.6',
    )
    fs.mkdirSync(path.join(extensionPath, 'hooks', 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(extensionPath, 'hooks', 'scripts', 'remote-control-state.mjs'),
      '// stub\n',
    )
  })

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('resolves the newest installed extension', () => {
    const older = path.join(
      tmpHome,
      '.cursor',
      'extensions',
      'devspecai.devspec-autopilot-0.4.0',
    )
    fs.mkdirSync(path.join(older, 'hooks', 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(older, 'hooks', 'scripts', 'remote-control-state.mjs'),
      '// stub\n',
    )
    assert.equal(resolveCursorDevspecExtensionPath(tmpHome), extensionPath)
  })

  it('prepends PLUGIN= for remote prompts when missing', () => {
    const prompt = 'Run the `devspec.remote` skill with this input: --session abc'
    const pinned = pinRemotePluginInPrompt(prompt, { homeDir: tmpHome })
    assert.ok(pinned.startsWith(`PLUGIN=${extensionPath}`))
    assert.ok(pinned.includes('Do NOT search ~/.claude/plugins'))
    assert.ok(pinned.endsWith(prompt))
  })

  it('is a no-op when PLUGIN= is already present', () => {
    const prompt = `${buildPluginPinBlock(extensionPath)}\n\nRun the \`devspec.remote\` skill`
    assert.equal(pinRemotePluginInPrompt(prompt, { homeDir: tmpHome }), prompt)
  })

  it('is a no-op for non-remote prompts', () => {
    const prompt = 'Run the `devspec.work` skill with this input: abc'
    assert.equal(pinRemotePluginInPrompt(prompt, { homeDir: tmpHome }), prompt)
  })
})
