#!/usr/bin/env node
/**
 * Unit tests for Agent skill paste prompt builder.
 * Run: node --experimental-strip-types --test src/skill-paste-prompt.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildSkillPastePrompt, skillNeedsPluginRoot } from './skill-paste-prompt.ts'

describe('skillNeedsPluginRoot', () => {
  it('is true for remote skills only', () => {
    assert.equal(skillNeedsPluginRoot('devspec.remote'), true)
    assert.equal(skillNeedsPluginRoot('devspec.remote-stop'), true)
    assert.equal(skillNeedsPluginRoot('devspec.remote'), false)
  })
})

describe('buildSkillPastePrompt', () => {
  const body = '# skill body\n'

  it('injects PLUGIN= for devspec.remote', () => {
    const prompt = buildSkillPastePrompt(
      'devspec.remote',
      body,
      '--session abc',
      'C:\\Users\\Brandon Young\\.cursor\\extensions\\devspecai.devspec-autopilot-0.3.14',
    )
    assert.match(
      prompt,
      /PLUGIN=C:\\Users\\Brandon Young\\.cursor\\extensions\\devspecai\.devspec-autopilot-0\.3\.14/,
    )
    assert.match(prompt, /Do NOT search ~\/\.claude\/plugins/)
    assert.match(prompt, /Run the `devspec\.remote` skill with this input: --session abc/)
    assert.ok(prompt.includes(body))
  })

  it('injects PLUGIN= for devspec.remote-stop', () => {
    const prompt = buildSkillPastePrompt(
      'devspec.remote-stop',
      body,
      undefined,
      '/home/u/.cursor/extensions/devspecai.devspec-autopilot-0.3.14',
    )
    assert.match(
      prompt,
      /PLUGIN=\/home\/u\/\.cursor\/extensions\/devspecai\.devspec-autopilot-0\.3\.14/,
    )
    assert.match(prompt, /Run the `devspec\.remote-stop` skill\./)
  })

  it('does not inject PLUGIN= for unrelated skills', () => {
    const prompt = buildSkillPastePrompt('devspec.remote', body, 'item-1', '/ext')
    assert.equal(prompt.includes('PLUGIN='), false)
    assert.equal(
      prompt,
      `Run the \`devspec.remote\` skill with this input: item-1\n\n---\n\n${body}`,
    )
  })
})
