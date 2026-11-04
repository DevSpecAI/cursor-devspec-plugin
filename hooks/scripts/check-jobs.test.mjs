// Check jobs on the wake channel (DevSpec item 55d71b0c; this plugin's item 9b6b66d1).
//
// What could break: a validator that takes a check job could start taking any shape
// (and an unknown dispatch must still refuse the whole batch); an automation run could
// stop arriving as before; a check job could be kept twice when the server lists it
// again on the next poll; the poller could stop saying it reads check jobs (DevSpec
// then never offers one); and busy could stop being true while the agent works a job,
// which makes DevSpec drop a job the agent has taken.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CHECK_JOB_WAKE_KEYS,
  checkJobAcceptanceKey,
  checkJobWakeText,
  inspectPollResponseV1,
} from './remote-poll-acceptance.mjs'
import { deliverCheckJobDispatches, remoteIngressNegotiationArgs } from './devspec-remote-poll.mjs'
import { buildOwnerMessageEvents, consumeInboxSlice } from './devspec-remote-wait.mjs'
import { REMOTE_WAKE_NOTIFY_PATTERN, resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'
import { isHarnessInjection, promptOrigin } from './mirror-turn.mjs'
import { turnNoticeIds, turnOwnsNoCommand, turnWakeFromEvents, turnWakeFromText } from './notice-reply.mjs'
import {
  FIXTURE_ID,
  fixtureAutomationDispatch,
  fixtureEnvelope,
  fixturePollResponse,
} from './remote-ingress-test-fixtures.mjs'

const CHECK_JOB = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c'
const OTHER_JOB = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d'
const RECORD = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e'

function checkJob(over = {}) {
  const id = over.id ?? CHECK_JOB
  return {
    id,
    kind: 'check_job',
    check_job_id: id,
    check_kind: 'conflict',
    record: { type: 'task', id: RECORD, title: 'Fix the login redirect' },
    entries: 3,
    high_risk: 1,
    yours: true,
    offered_at: '2026-11-04T03:00:00.000Z',
    delivery_connection_id: FIXTURE_ID.connection,
    ...over,
  }
}

function accept(dispatches) {
  return inspectPollResponseV1(fixturePollResponse({ dispatches }), FIXTURE_ID.connection)
}

describe('wake-channel validator: an automation run or a check job, nothing else', () => {
  it('still accepts an automation run exactly as before, with no check jobs', () => {
    const automation = fixtureAutomationDispatch()
    const accepted = accept([automation])
    assert.equal(accepted.ok, true)
    assert.deepEqual(accepted.automations, [automation])
    assert.deepEqual(accepted.checkJobs, [])
  })

  it('accepts a check job beside an automation run and keeps the two lanes apart', () => {
    const automation = fixtureAutomationDispatch()
    const job = checkJob()
    const accepted = accept([automation, job])
    assert.equal(accepted.ok, true)
    assert.deepEqual(accepted.automations, [automation])
    assert.deepEqual(accepted.checkJobs, [job])
    assert.deepEqual(Object.keys(job), CHECK_JOB_WAKE_KEYS)
  })

  it('accepts every check kind and record type the contract names, and an unset title', () => {
    for (const check_kind of ['conflict', 'conflict_decisions', 'duplicate', 'staleness']) {
      assert.equal(accept([checkJob({ check_kind })]).ok, true, check_kind)
    }
    for (const type of ['task', 'memory', 'artifact', 'proposal']) {
      assert.equal(accept([checkJob({ record: { type, id: RECORD, title: 'x' } })]).ok, true, type)
    }
    assert.equal(accept([checkJob({ record: { type: 'task', id: RECORD, title: '' } })]).ok, true)
  })

  it('rejects an unknown dispatch shape exactly as before check jobs', () => {
    const taskAssignment = { ...fixtureAutomationDispatch(), kind: 'task_assignment' }
    const refused = accept([taskAssignment])
    assert.equal(refused.ok, false)
    assert.match(refused.error, /automation dispatch/)
    assert.equal(accept([{ id: CHECK_JOB }]).ok, false)
    assert.equal(accept(['check_job']).ok, false)
  })

  it('rejects a check job with an extra or a missing key, at the top or in its record', () => {
    const extra = accept([{ ...checkJob(), title: 'record text has no place here' }])
    assert.equal(extra.ok, false)
    assert.match(extra.error, /check job dispatch/)
    const { yours: _yours, ...missing } = checkJob()
    assert.equal(accept([missing]).ok, false)
    assert.equal(accept([checkJob({ record: { type: 'task', id: RECORD, title: 't', text: 'body' } })]).ok, false)
    assert.equal(accept([checkJob({ record: { type: 'task', id: RECORD } })]).ok, false)
  })

  it('rejects a check job whose values break the contract', () => {
    const bad = [
      checkJob({ check_job_id: OTHER_JOB }),
      checkJob({ delivery_connection_id: FIXTURE_ID.requester }),
      checkJob({ check_kind: 'review' }),
      checkJob({ record: { type: 'action_item', id: RECORD, title: 't' } }),
      checkJob({ record: { type: 'task', id: 'not-a-uuid', title: 't' } }),
      checkJob({ entries: -1 }),
      checkJob({ entries: 1.5 }),
      checkJob({ high_risk: 4 }),
      checkJob({ yours: 'true' }),
      checkJob({ offered_at: 'yesterday' }),
    ]
    for (const job of bad) assert.equal(accept([job]).ok, false, JSON.stringify(job))
  })

  it('refuses the whole batch when one item is bad, as it always has', () => {
    const refused = accept([fixtureAutomationDispatch(), checkJob(), checkJob({ id: OTHER_JOB, entries: 'two' })])
    assert.equal(refused.ok, false)
    assert.equal(refused.automations, undefined)
    assert.equal(accept([checkJob(), checkJob()]).ok, false, 'one id twice in one batch')
  })
})

describe('check job negotiation, wake and turn', () => {
  it('every poll says it reads check jobs, version 1', () => {
    assert.equal(remoteIngressNegotiationArgs().check_job_version, 1)
  })

  it('wakes with the one contract line naming the record', () => {
    assert.equal(
      checkJobWakeText(checkJob()),
      'A check is waiting on "Fix the login redirect": take it with claim_check_job, rule every entry with record_check_rulings, then carry on.',
    )
    assert.match(checkJobWakeText(checkJob({ record: { type: 'memory', id: RECORD, title: ' ' } })), new RegExp(`waiting on memory ${RECORD}:`))
  })

  it('a kept check job wakes the agent, and Cursor is told to notify on it', () => {
    const job = checkJob()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-check-job-'))
    try {
      const inbox = path.join(dir, 'inbox.jsonl')
      const record = {
        type: 'check_job_dispatches', connection_id: FIXTURE_ID.connection, session_id: null,
        count: 1, next_after_message_id: 'dispatch-1', messages: [job], acceptance_key: checkJobAcceptanceKey(job),
      }
      const tampered = { ...record, messages: [{ ...job, record: { ...job.record, text: 'x' } }] }
      const wrongKey = { ...record, acceptance_key: `automation:${job.id}` }
      fs.writeFileSync(inbox, [tampered, wrongKey, record].map((line) => JSON.stringify(line)).join('\n') + '\n')
      const slice = consumeInboxSlice(inbox, 0, { canonicalOnly: true, includeDispatches: true, oneCommandTurn: true })
      assert.equal(slice.batches.length, 1)
      assert.equal(slice.lines.length, 3, 'the tampered and mis-keyed records are skipped, never woken on')
      const events = buildOwnerMessageEvents(slice.batches[0], { inboxFile: inbox })
      assert.deepEqual(events.map((event) => [event.type, event.reason ?? null]), [['check_job', null], ['wake', 'check_job']])
      assert.equal(events[0].instruction, checkJobWakeText(job))
      assert.deepEqual(events[0].check_job, job)
      const notify = new RegExp(REMOTE_WAKE_NOTIFY_PATTERN)
      for (const event of events) assert.match(JSON.stringify(event), notify)
      // The wake text reaching the model is harness plumbing, never a person's prompt.
      const prompt = events.map((event) => JSON.stringify(event)).join('\n')
      assert.equal(isHarnessInjection(prompt), true)
      assert.equal(promptOrigin('{}', prompt), 'task-notification')
      // A turn only check jobs woke owns no command: no trail, and no notice reply.
      const wake = turnWakeFromEvents(events)
      assert.deepEqual(wake, { checkJobIds: [CHECK_JOB] })
      assert.deepEqual(turnWakeFromText(prompt), wake)
      const turn = { startedAt: 1, noticeIds: [], otherWake: false, ...wake }
      assert.equal(turnOwnsNoCommand({ record: turn }), true)
      assert.equal(turnNoticeIds({ record: turn }), null)
      assert.equal(turnOwnsNoCommand({ record: { ...turn, otherWake: true } }), false, 'a command in the turn owns it')
      assert.equal(turnOwnsNoCommand({ record: turn, connectionState: { local_turn: { attempt_id: 'a' } } }), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a newly kept check job starts the turn (busy) without marking it a dispatched run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-check-turn-'))
    try {
      const emitted = []
      let duplicate = false
      const deliver = () => deliverCheckJobDispatches(FIXTURE_ID.connection, [checkJob()], 'dispatch-1', null, {
        dir,
        emit: (line) => emitted.push(JSON.parse(line)),
        appendInboxFn: () => ({ ok: true, duplicate }),
      })
      const first = await deliver()
      assert.deepEqual(first, { ok: true, acceptedCount: 1 })
      assert.deepEqual(emitted.map((line) => line.type), ['check_job'])
      const marker = JSON.parse(fs.readFileSync(path.join(dir, `${FIXTURE_ID.connection}.turn`), 'utf8'))
      assert.equal(typeof marker.startedAt, 'number')
      assert.equal(marker.remoteTurn, undefined, 'a check job is no dispatched run: no sessionless trail')
      fs.rmSync(path.join(dir, `${FIXTURE_ID.connection}.turn`))
      duplicate = true
      assert.deepEqual(await deliver(), { ok: true, acceptedCount: 0 })
      assert.equal(fs.existsSync(path.join(dir, `${FIXTURE_ID.connection}.turn`)), false, 'a job already kept starts nothing')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('live poller with check jobs', () => {
  it('negotiates on every poll, keeps a re-listed job once, and reports busy across the turn it starts', async () => {
    const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')
    const polls = []
    let served = 0
    const job = checkJob()
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        const parsed = JSON.parse(body)
        const call = parsed.params ?? {}
        let result = { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
        if (call.name === 'poll_connection') {
          polls.push(call.arguments ?? {})
          served++
          // The server lists every open job on every poll until it is ruled or dropped.
          const changed = served <= 2
          if (!changed) await new Promise((r) => setTimeout(r, 100))
          result = {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'live',
                session_id: null,
                changed,
                cursor: null,
                cursor_v2: `after:tick-${Math.min(served, 2)}`,
                dispatch_cursor: '2026-11-04T03:00:00.000Z',
                ...(changed
                  ? { ingress: fixtureEnvelope({ envelopeId: `e0000000-0000-4000-8000-00000000000${served}`, wakeKind: 'advisory_update', commands: [] }), dispatches: [job] }
                  : {}),
              }),
            }],
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-check-poller-'))
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connDir, { recursive: true })
    const inboxPath = path.join(connDir, `${FIXTURE_ID.connection}.inbox.jsonl`)
    const markerPath = path.join(connDir, `${FIXTURE_ID.connection}.turn`)
    fs.writeFileSync(
      path.join(connDir, `${FIXTURE_ID.connection}.json`),
      JSON.stringify({
        enabled: true,
        connection_id: FIXTURE_ID.connection,
        session_id: null,
        agent_name: 'Cursor',
        token: 'dvs_test_token',
        mcp_url: `http://127.0.0.1:${server.address().port}/mcp`,
        ingress_version: 1,
      }),
      { mode: 0o600 },
    )
    const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', FIXTURE_ID.connection], {
      env: { ...process.env, HOME: home },
    })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const until = async (pred, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs
      while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
      return pred()
    }
    const inbox = () => {
      try {
        return fs.readFileSync(inboxPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      } catch {
        return []
      }
    }
    try {
      assert.ok(await until(() => polls.some((p) => p.busy === true)), `no busy:true poll after the job arrived; stderr:\n${stderr}`)
      assert.ok(served >= 2, 'the job was listed twice')
      const kept = inbox().filter((line) => line.type === 'check_job_dispatches')
      assert.equal(kept.length, 1, 'a job the server lists again is kept once')
      assert.deepEqual(kept[0].messages, [job])
      assert.equal(kept[0].acceptance_key, `check_job:${CHECK_JOB}`)
      // The turn ends (the Stop hook removes the marker): the next poll says so.
      fs.rmSync(markerPath, { force: true })
      const busyAt = polls.findIndex((p) => p.busy === true)
      assert.ok(await until(() => polls.slice(busyAt + 1).some((p) => p.busy === false)), `no busy:false after the turn ended; stderr:\n${stderr}`)
      assert.ok(polls.every((p) => p.check_job_version === 1), 'every poll negotiates check jobs')
    } finally {
      child.kill('SIGKILL')
      try { fs.rmSync(resolveSpaceFreeWakeFile(FIXTURE_ID.connection), { force: true }) } catch { /* ignore */ }
      fs.rmSync(home, { recursive: true, force: true })
      await new Promise((r) => server.close(r))
    }
  })
})
