import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { activeDiagnostics, appendDiagnostic, diagnosticStatus, exportDiagnostics, LIMITS, normalizeDiagnostic, pruneDiagnostics, startDiagnostics, stopDiagnostics } from './local-diagnostics.mjs'
import { fixture, ID, OTHER } from '../../tests/helpers/local-diagnostics.mjs'
const event = { kind: 'tool', phase: 'end', source: 'cursor_hook', tool: 'read', channel: 'tool', duration_ms: 10, outcome: 'ok' }

test('default off and exact session isolation; start/status/stop/expiry', () => fixture(({ root }) => {
  assert.equal(activeDiagnostics({ connectionId: ID }), null)
  assert.equal(appendDiagnostic({ connectionId: ID }, event), false)
  assert.equal(fs.existsSync(root), false)
  const now = Date.now(), run = startDiagnostics(ID, { now, minutes: 1 })
  assert.equal(diagnosticStatus(ID).active, true)
  assert.throws(() => startDiagnostics(ID), /already active/)
  assert.equal(appendDiagnostic({ connectionId: OTHER }, event), false)
  assert.equal(appendDiagnostic({ connectionId: ID }, event), true)
  assert.equal(activeDiagnostics({ connectionId: ID }, { now: now + 60000 }), null)
  assert.equal(appendDiagnostic({ connectionId: ID }, event, { now: now + 60000 }), false)
  stopDiagnostics(ID)
  assert.equal(diagnosticStatus(ID).active, false)
  assert.equal(fs.existsSync(run.dir), true)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(run.dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(run.dir, 'events.jsonl')).mode & 0o777, 0o600)
  }
}))

test('closed schema and explicit export exclude private fields and unknown interval claims', () => fixture(({ run }) => {
  assert.equal(appendDiagnostic({ connectionId: ID }, { ...event, tool: 'curl Bearer SYMBOLIC_SECRET', message: 'SYMBOLIC_PRIVATE', error: 'SYMBOLIC_ERROR', headers: { authorization: 'SYMBOLIC_KEY' }, stack: 'SYMBOLIC_STACK', duration_ms: Infinity }), true)
  const output = exportDiagnostics(ID), raw = fs.readFileSync(output, 'utf8'), bundle = JSON.parse(raw)
  assert.equal(raw.includes('SYMBOLIC'), false)
  assert.equal(bundle.events[0].tool, 'other')
  assert.equal(bundle.events[0].duration_ms, undefined)
  assert.ok(bundle.limitations.some(x => x.includes('unknown')))
  assert.equal(bundle.sources.schema_discovery, 'unavailable')
  assert.equal(bundle.hostVersion, '2026.09.18')
  assert.equal(path.dirname(output), run.dir)
  assert.equal(normalizeDiagnostic({ ...event, kind: 'SYMBOLIC_PRIVATE' }), null)
}, true))

test('size, event and retained run budgets with age cleanup', () => fixture(({ root, seed }) => {
  const now = Date.now(), run = startDiagnostics(ID, { now })
  const log = path.join(run.dir, 'events.jsonl')
  fs.writeFileSync(log, 'x'.repeat(LIMITS.segmentBytes - 10))
  assert.equal(appendDiagnostic({ connectionId: ID }, event), true)
  assert.ok(fs.statSync(log).size < LIMITS.segmentBytes)
  assert.ok(fs.statSync(log + '.1').size <= LIMITS.segmentBytes)
  const metaPath = path.join(run.dir, 'session.json'), meta = JSON.parse(fs.readFileSync(metaPath))
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, count: LIMITS.events }))
  assert.equal(appendDiagnostic({ connectionId: ID }, event), false)
  stopDiagnostics(ID)
  for (let i = 2; i <= 6; i++) {
    const id = `${i}0000000-0000-4000-8000-00000000000${i}`
    seed(id); startDiagnostics(id, { now: now + i }); stopDiagnostics(id)
  }
  assert.equal(fs.readdirSync(root).filter(x => /^[a-f0-9-]{36}$/.test(x)).length, LIMITS.runs)
  pruneDiagnostics({ now: now + LIMITS.retentionMs + 10 })
  assert.equal(fs.readdirSync(root).length, 0)
}))

test('I/O failure, unsafe paths and malformed metadata cannot block normal callers', () => fixture(({ run }) => {
  const log = path.join(run.dir, 'events.jsonl')
  fs.rmSync(log); fs.mkdirSync(log)
  assert.equal(appendDiagnostic({ connectionId: ID }, event), false)
  assert.throws(() => startDiagnostics('../elsewhere'), /UUID/)
  assert.throws(() => startDiagnostics(OTHER), /No enabled/)
  assert.throws(() => startDiagnostics(ID, { minutes: 61 }), /1–60/)
}, true))

test('local export revalidates modified event data rather than archiving arbitrary files', () => fixture(({ run }) => {
  fs.writeFileSync(path.join(run.dir, 'events.jsonl'), JSON.stringify({ ...event, seq: 1, at: new Date().toISOString(), message: 'SYMBOLIC_SECRET', token: 'SYMBOLIC_TOKEN' }) + '\n')
  fs.writeFileSync(path.join(run.dir, 'raw.log'), 'SYMBOLIC_PRIVATE')
  const metaPath = path.join(run.dir, 'session.json'), meta = JSON.parse(fs.readFileSync(metaPath))
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, sources: { private: 'SYMBOLIC_SECRET' }, limitations: ['SYMBOLIC_PRIVATE'] }))
  assert.equal(fs.readFileSync(exportDiagnostics(ID), 'utf8').includes('SYMBOLIC'), false)
}, true))

test('explicit CLI starts observer, observes append metadata, then stops without uploads', { timeout: 12000 }, () => fixture(async ({ home, connections }) => {
  const transcriptDir = path.join(home, '.cursor', 'projects', 'fixture', 'agent-transcripts', ID)
  fs.mkdirSync(transcriptDir, { recursive: true })
  const transcript = path.join(transcriptDir, `${ID}.jsonl`)
  fs.writeFileSync(transcript, 'SYMBOLIC_RAW_TRANSCRIPT\n')
  const cli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./diagnostics-command.mjs', import.meta.url)), ...args, '--connection', ID], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.resume()
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Diagnostic CLI failed')))
  })
  const started = await cli(['start', '--minutes', '1'])
  try {
    assert.equal(started.active, true); assert.equal(started.observer, true); assert.equal(started.uploads, false)
    // This wait observes a real collector process, not product behaviour.
    await new Promise(resolve => setTimeout(resolve, 1200))
    fs.appendFileSync(transcript, 'SYMBOLIC_MORE\n')
    await new Promise(resolve => setTimeout(resolve, 1200))
    const status = await cli(['status']); assert.equal(status.active, true)
    const exported = await cli(['export'])
    const raw = fs.readFileSync(exported.export, 'utf8'), bundle = JSON.parse(raw)
    assert.equal(raw.includes('SYMBOLIC'), false)
    assert.ok(bundle.events.some(e => e.kind === 'transcript' && e.appended_bytes > 0))
    assert.equal(bundle.sources.transcript, 'available')
  } finally { await cli(['stop']); await new Promise(resolve => setTimeout(resolve, 1100)) }
  assert.equal((await cli(['status'])).active, false)
}))
