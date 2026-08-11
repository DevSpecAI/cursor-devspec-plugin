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
  expandRemoteControlLaunchPrompt,
  parseRemoteSkillIdFromPrompt,
  pinRemotePluginInPrompt,
  promptAlreadyHasPluginPin,
  promptAlreadyHasSkillBody,
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

describe('resolveCursorDevspecExtensionPath semver', () => {
  /** @type {string} */
  let tmpHome

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-pin-semver-'))
  })

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('picks 0.4.14 over 0.4.9 (lexicographic trap)', () => {
    // Lex sort ranks "…-0.4.9" after "…-0.4.14" because '9' > '1'. Semver must not.
    const v49 = path.join(
      tmpHome,
      '.cursor',
      'extensions',
      'devspecai.devspec-autopilot-0.4.9',
    )
    const v414 = path.join(
      tmpHome,
      '.cursor',
      'extensions',
      'devspecai.devspec-autopilot-0.4.14',
    )
    for (const dir of [v49, v414]) {
      fs.mkdirSync(path.join(dir, 'hooks', 'scripts'), { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'hooks', 'scripts', 'remote-control-state.mjs'),
        '// stub\n',
      )
    }
    assert.equal(resolveCursorDevspecExtensionPath(tmpHome), v414)
  })
})

describe('expandRemoteControlLaunchPrompt', () => {
  /** @type {string} */
  let tmpHome
  /** @type {string} */
  let extensionPath

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-expand-'))
    extensionPath = path.join(
      tmpHome,
      '.cursor',
      'extensions',
      'devspecai.devspec-autopilot-0.4.7',
    )
    fs.mkdirSync(path.join(extensionPath, 'hooks', 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(extensionPath, 'hooks', 'scripts', 'remote-control-state.mjs'),
      '// stub\n',
    )
    fs.mkdirSync(path.join(extensionPath, 'skills', 'devspec.remote'), { recursive: true })
    fs.writeFileSync(
      path.join(extensionPath, 'skills', 'devspec.remote', 'SKILL.md'),
      [
        '---',
        'name: devspec.remote',
        '---',
        '',
        '# DevSpec Remote Control',
        '',
        '## Plugin root',
        '',
        'Call register_connection then attach_connection.',
        '',
      ].join('\n'),
    )
  })

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('parses remote skill ids from web headers', () => {
    assert.equal(
      parseRemoteSkillIdFromPrompt('Run the `devspec.remote` skill with this input: x'),
      'devspec.remote',
    )
    assert.equal(parseRemoteSkillIdFromPrompt('Run the `devspec.remote-stop` skill.'), 'devspec.remote-stop')
    assert.equal(parseRemoteSkillIdFromPrompt('Run the `devspec.work` skill'), null)
  })

  it('embeds PLUGIN= and the Cursor skill body for cold attach prompts', () => {
    const prompt = 'Run the `devspec.remote` skill with this input: --session abc'
    const expanded = expandRemoteControlLaunchPrompt(prompt, { homeDir: tmpHome })
    assert.ok(expanded.startsWith(`PLUGIN=${extensionPath}`))
    assert.ok(expanded.includes('Do NOT glob for the skill'))
    assert.ok(expanded.includes('# DevSpec Remote Control'))
    assert.ok(expanded.includes('Plugin root'))
    assert.ok(expanded.includes('register_connection'))
    assert.ok(promptAlreadyHasSkillBody(expanded, 'devspec.remote'))
  })

  it('does not double-embed when the skill body is already present', () => {
    const once = expandRemoteControlLaunchPrompt(
      'Run the `devspec.remote` skill with this input: --session abc',
      { homeDir: tmpHome },
    )
    const twice = expandRemoteControlLaunchPrompt(once, { homeDir: tmpHome })
    assert.equal(twice, once)
  })
})
