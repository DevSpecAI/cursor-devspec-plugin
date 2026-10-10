#!/usr/bin/env node
/**
 * Cursor reports the model it runs (item cc47378e): hooks write it, the poller sends it.
 * Run: node --test hooks/scripts/agent-telemetry.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { agentStatsArgs, recordRuntimeReport, runtimeReportFromHookInput } from './agent-telemetry.mjs'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const NOW = new Date('2026-10-10T12:00:00.000Z')

describe('runtimeReportFromHookInput', () => {
  it('reads the model and effort Cursor hands every hook', () => {
    const report = runtimeReportFromHookInput({
      model: 'claude-4.5-opus',
      model_id: 'claude-opus-5-5',
      model_params: [{ id: 'thinking', value: 'true' }, { id: 'effort', value: 'max' }],
    }, NOW)
    assert.deepEqual(report.model, { provider: 'cursor', id: 'claude-opus-5-5' })
    assert.equal(report.thinkingLevel, 'max')
    assert.equal(report.v, 1)
    assert.equal(report.at, NOW.toISOString())
  })

  it('falls back to the legacy model slug', () => {
    assert.deepEqual(runtimeReportFromHookInput({ model: 'composer-1' }, NOW).model, { provider: 'cursor', id: 'composer-1' })
  })

  it('sends no thinking level the server would reject, so the report is not dropped', () => {
    const report = runtimeReportFromHookInput({ model: 'gpt-6', model_params: [{ id: 'effort', value: 'turbo' }] }, NOW)
    assert.equal(report.thinkingLevel, null)
  })

  it('is null when the hook names no model', () => {
    assert.equal(runtimeReportFromHookInput({ conversation_id: 'c' }), null)
    assert.equal(runtimeReportFromHookInput(null), null)
  })
})

describe('the hook writes it and the poll sends it', () => {
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-telemetry-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('round-trips a hook payload into poll arguments', () => {
    assert.equal(recordRuntimeReport(CONNECTION, JSON.stringify({ model: 'gpt-6-astra' }), { dir, now: NOW }), true)
    assert.deepEqual(agentStatsArgs(CONNECTION, { dir }).agent_stats.model, { provider: 'cursor', id: 'gpt-6-astra' })
  })

  it('adds nothing to the poll before any hook has run, or for a bad payload', () => {
    const other = '99999999-8888-4777-8666-555555555555'
    assert.deepEqual(agentStatsArgs(other, { dir }), {})
    assert.equal(recordRuntimeReport(other, 'not json', { dir }), false)
    assert.deepEqual(agentStatsArgs(other, { dir }), {})
  })

  it('never writes outside the connections folder for a malformed connection id', () => {
    assert.equal(recordRuntimeReport('../escape', JSON.stringify({ model: 'x' }), { dir }), false)
    assert.deepEqual(agentStatsArgs('../escape', { dir }), {})
  })
})
