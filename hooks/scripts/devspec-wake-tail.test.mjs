/**
 * The wake file's two readers (devspec-wake-tail.mjs): the background tail, whose output
 * Cursor notifies the agent from, and the reader the agent runs when a notification
 * arrives. Every test runs in its own temporary home.
 * Run: node --test hooks/scripts/devspec-wake-tail.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { after, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendWakeEvents, CURSOR_NOTIFY_MATCH_LIMIT, REMOTE_WAKE_NOTIFY_PATTERN, splitWakes, wakeLines } from './devspec-wake-file.mjs'
import { CURSOR_SHELL_OUTPUT_MAX_CHARS, fitsShellOutput, readNoteText } from './hook-context-budget.mjs'
import {
  LISTENER_MATCH_BUDGET,
  LISTENER_REASON,
  LISTENER_RELIEF_AT,
  LISTENER_REPLACE_NOTE,
  LISTENER_STOPPED_NOTE,
  listenerAdvice,
  listenerCommand,
  listenerLeasePath,
  NOTHING_UNREAD,
  NOTIFY_NOTE,
  notifyLine,
  notifyMatches,
  readerCommand,
  readerHeader,
  readerPage,
  readListenerLease,
  readPositionPath,
  readWakes,
  startOffset,
} from './devspec-wake-tail.mjs'
import { RECALL_IN_NEXT_WAKE, recallWakeOut } from './turn-recall.mjs'
import { noteIdIn } from '../../tests/helpers/note-reads.mjs'

const realScript = fileURLToPath(new URL('./devspec-wake-tail.mjs', import.meta.url))
const scriptsDir = path.dirname(realScript)
const CONN = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const NOTIFY = new RegExp(REMOTE_WAKE_NOTIFY_PATTERN)

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

const until = async (check, ms = 8_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

/** A home with a live connection and its wake file, named as the host names it. */
function connected() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wake-reader-'))
  roots.push(home)
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  const state = path.join(dir, `${CONN}.json`)
  fs.writeFileSync(state, JSON.stringify({ connection_id: CONN, enabled: true, agent_name: 'Cursor' }), { mode: 0o600 })
  const file = path.join(home, 'wakes', `${CONN}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  const world = {
    home,
    dir,
    file,
    append: (events) => appendWakeEvents(file, events),
    text: () => fs.readFileSync(file, 'utf8'),
    end: () => fs.writeFileSync(state, JSON.stringify({ connection_id: CONN, enabled: false, end_reason: 'local_stop', agent_name: 'Cursor' })),
    /** One read in this process: what it printed, and the page it returns. */
    async read(options = {}) {
      let printed = null
      const page = await readWakes({ file, home, dir, settleMs: 0, write: async (text) => { printed = text }, ...options })
      return { printed, page }
    },
    /** One read as the agent runs it: the real command, in its own process. */
    readCli() {
      const run = spawnSync(process.execPath, [realScript, 'read', '--file', file], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30_000 })
      assert.equal(run.status, 0, run.stderr)
      assert.equal(run.stderr, '', 'nothing beside the wakes in the output')
      return run.stdout
    },
  }
  return world
}

/** A room command's wake, as the host follow writes it. */
const command = (n, body = `Command ${n}: fix the settings redirect`) => [
  { type: 'owner_message', from: 'Ali', authority: 'owner', message_id: `m${n}`, body_chars: body.length, body, session_id: 's1' },
  { type: 'room_unread', session_id: 's1', advisory: true, executable: false, unread: 1 },
  { type: 'wake', reason: 'canonical_conversational_command', session_id: 's1', count: 1 },
]

/** A command's wake exactly `chars` long as the wake file holds it. */
function commandOfLength(chars, n = 1) {
  const bare = wakeLines(command(n, '')).length
  let body = 'a'.repeat(Math.max(0, chars - bare))
  for (let pass = 0; pass < 4; pass += 1) {
    const over = wakeLines(command(n, body)).length - chars
    if (over === 0) break
    body = 'a'.repeat(Math.max(0, body.length - over))
  }
  const events = command(n, body)
  assert.equal(wakeLines(events).length, chars)
  return events
}

const notice = (id) => [
  { type: 'system_notice', notice_id: id, audience: 'needs_person', content: `Notice ${id}: a held change` },
  { type: 'wake', reason: 'exact_connection_system_notice', count: 1 },
]

/** The header and the wakes after it, of one read's output. */
function parsed(output) {
  const at = output.indexOf('\n') + 1
  return { header: JSON.parse(output.slice(0, at)), wakes: output.slice(at) }
}

const recall = (n) => ({
  version: 1,
  formatted_block: `== PROACTIVE PROJECT RECALL ==\n${Array.from({ length: 16 }, (_, i) => `- [MEMORY · decision] **Decision ${n}.${i}** keeps the settings redirect (get_memory({ id: "${i}" }))`).join('\n')}`,
  seen_keys: [`memory:00000000-0000-4000-8000-00000000000${n}:v1`],
})

describe('the wake reader: what the agent runs when a wake notification arrives', () => {
  it('a single wake: printed whole under its header, then marked read, so the next read has nothing', async () => {
    const world = connected()
    const events = command(1)
    world.append(events)
    const first = await world.read()
    assert.equal(first.printed, readerHeader(1, 0) + wakeLines(events))
    assert.deepEqual(parsed(first.printed).header, { devspec_wakes: { returned: 1, remaining: 0 } })
    assert.equal(JSON.parse(fs.readFileSync(readPositionPath(CONN, world.dir), 'utf8')).offset, Buffer.byteLength(world.text()))
    const second = await world.read()
    assert.equal(second.printed, readerHeader(0, 0, NOTHING_UNREAD))
    // A wake that arrives later is the only one the next read prints.
    world.append(notice('n9'))
    assert.equal((await world.read()).printed, readerHeader(1, 0) + wakeLines(notice('n9')))
  })

  it('several wakes together: oldest first, each whole, in one output', async () => {
    const world = connected()
    const wakes = [command(1), notice('n1'), [{ type: 'question_answer', question_id: 'q1', answer: 'Use the redirect' }, { type: 'wake', count: 1 }]]
    for (const wake of wakes) world.append(wake)
    const { printed, page } = await world.read()
    assert.equal(printed, readerHeader(3, 0) + wakes.map(wakeLines).join(''))
    assert.equal(page.printed, 3)
    assert.ok(fitsShellOutput(printed))
  })

  it('a wake too long to print inline reaches the agent whole through a note it is pointed at; nothing is cut', async () => {
    const world = connected()
    const big = command(1, `${'x'.repeat(24_000)}THE-END`)
    // Fits Cursor's limit on its own, but not beside the header.
    const edge = commandOfLength(CURSOR_SHELL_OUTPUT_MAX_CHARS, 2)
    // Fits beside the header exactly: printed inline.
    const inline = commandOfLength(CURSOR_SHELL_OUTPUT_MAX_CHARS - readerHeader(1, 2).length, 3)
    for (const wake of [big, edge, inline]) world.append(wake)

    const outputs = []
    for (let read = 0; read < 4; read += 1) outputs.push((await world.read()).printed)
    for (const output of outputs) assert.ok(fitsShellOutput(output), `${output.length} characters in one output`)
    const first = parsed(outputs[0])
    assert.deepEqual(first.header.devspec_wakes, { returned: 2, remaining: 1 })
    const lines = first.wakes.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((line) => line.type), ['wake_in_note', 'wake_in_note'])
    for (const [line, events] of [[lines[0], big], [lines[1], edge]]) {
      assert.deepEqual(line.carries, ['owner_message', 'room_unread', 'wake'])
      assert.equal(readNoteText(noteIdIn(line.read), { home: world.home }), wakeLines(events), 'the whole wake, byte for byte')
    }
    assert.ok(!outputs[0].includes('THE-END'), 'no part of the long command inline')
    assert.equal(outputs[1], readerHeader(1, 0) + wakeLines(inline), 'one that fits beside the header goes out as it is')
    assert.equal(outputs[2], readerHeader(0, 0, NOTHING_UNREAD))
  })

  it('wakes that do not fit one output wait for the next read, and the header says how many remain', async () => {
    const world = connected()
    const wakes = [1, 2, 3, 4, 5].map((n) => commandOfLength(6_000, n))
    for (const wake of wakes) world.append(wake)
    const one = await world.read()
    assert.deepEqual(parsed(one.printed).header.devspec_wakes, { returned: 3, remaining: 2 })
    assert.equal(parsed(one.printed).wakes, wakes.slice(0, 3).map(wakeLines).join(''))
    const two = await world.read()
    assert.deepEqual(parsed(two.printed).header.devspec_wakes, { returned: 2, remaining: 0 })
    assert.equal(parsed(two.printed).wakes, wakes.slice(3).map(wakeLines).join(''))
    for (const output of [one.printed, two.printed]) assert.ok(fitsShellOutput(output))
    assert.equal(parsed(one.printed).wakes + parsed(two.printed).wakes, world.text(), 'every wake once, in order, nothing lost')
  })

  it('a failed print marks nothing read: the same wakes come again, whole', async () => {
    const world = connected()
    const wakes = [command(1), notice('n1')]
    for (const wake of wakes) world.append(wake)
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    await assert.rejects(world.read({ write: async () => { throw epipe } }), /EPIPE/)
    assert.equal(fs.existsSync(readPositionPath(CONN, world.dir)), false, 'nothing marked read')
    // Part of the output went out before the write failed: still nothing marked.
    let partial = ''
    await assert.rejects(world.read({ write: async (text) => { partial = text.slice(0, 40); throw epipe } }), /EPIPE/)
    assert.ok(partial.length > 0)
    assert.equal(fs.existsSync(readPositionPath(CONN, world.dir)), false)
    assert.equal((await world.read()).printed, readerHeader(2, 0) + wakes.map(wakeLines).join(''))
  })

  it('a failed print, for real: the agent\'s end of the output closes first, the command exits 1, and the wakes stay unread', async () => {
    const world = connected()
    world.append(command(1))
    const child = spawn(process.execPath, [realScript, 'read', '--file', world.file], { env: { PATH: process.env.PATH, HOME: world.home } })
    child.stdout.destroy()
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const code = await new Promise((resolve) => child.once('close', resolve))
    assert.equal(code, 1, stderr)
    assert.match(stderr, /none was marked read/)
    assert.equal(world.readCli(), readerHeader(1, 0) + wakeLines(command(1)))
  })

  for (const marked of [19_950, 19_990]) {
    it(`DevSpec's case: a ${marked.toLocaleString('en-US')}-character room command whose recall follows in a wake of its own: the command reaches the agent whole, then the pointer, each output within the limit, never a partial command`, () => {
      const world = connected()
      // The command's wake as written ends with the line that says its recall is next
      // (that line and its line break: the wake's closing empty line is already counted).
      const events = commandOfLength(marked - (JSON.stringify(RECALL_IN_NEXT_WAKE).length + 1))
      const out = recallWakeOut(events, recall(1), { home: world.home, connectionId: CONN })
      assert.equal(out.recall, 'separate')
      assert.equal(wakeLines(out.wakes[0]).length, marked)
      // The fixture DevSpec described: the two wakes do not fit one output together.
      assert.equal(fitsShellOutput(out.wakes.map(wakeLines).join('')), false)
      // The host follow writes them as it does (devspec-remote-wait.mjs --follow).
      world.append(out.events)
      world.append(out.recallWake)

      const outputs = []
      for (let read = 0; read < 3; read += 1) outputs.push(world.readCli())
      for (const output of outputs) assert.ok(fitsShellOutput(output), `${output.length} characters in one output`)
      const body = events[0].body
      // The command never arrives in part: wherever its text is, all of it is.
      for (const output of outputs) assert.ok(!output.includes('aaaa') || output.includes(body), 'a partial command')
      const commandWake = wakeLines(out.events)
      const recallWake = wakeLines(out.recallWake)
      if (fitsShellOutput(readerHeader(1, 1) + commandWake)) {
        // Inline: the command's own wake, byte for byte, then the pointer.
        assert.equal(outputs[0], readerHeader(1, 1) + commandWake)
        assert.equal(outputs[1], readerHeader(1, 0) + recallWake)
      } else {
        // Too long to go out beside the header: whole in a note, and the pointer beside it.
        const first = parsed(outputs[0])
        assert.deepEqual(first.header.devspec_wakes, { returned: 2, remaining: 0 })
        const [line, ...rest] = splitWakes(first.wakes).wakes
        assert.equal(JSON.parse(line).type, 'wake_in_note')
        assert.equal(readNoteText(noteIdIn(JSON.parse(line).read), { home: world.home }), commandWake, 'the command, byte for byte, in the note')
        assert.deepEqual(rest, [recallWake])
      }
      assert.equal(outputs.at(-1), readerHeader(0, 0, NOTHING_UNREAD))
    })
  }

  it('a wake still being written waits; lines with no closing empty line print once the file stops growing', async () => {
    const world = connected()
    world.append(command(1))
    const partial = JSON.stringify({ type: 'owner_message', message_id: 'm2', body: 'half' })
    fs.appendFileSync(world.file, partial)
    assert.equal((await world.read()).printed, readerHeader(1, 0) + wakeLines(command(1)), 'only the whole wake')
    // Lines from a wait older than the wake boundary: whole once the file has not grown.
    const legacy = `\n${JSON.stringify({ type: 'wake', count: 1 })}\n`
    fs.appendFileSync(world.file, legacy)
    assert.equal((await world.read({ settleMs: 50 })).printed, readerHeader(1, 0) + partial + legacy)
    assert.equal((await world.read()).printed, readerHeader(0, 0, NOTHING_UNREAD))
  })

  it('an ended connection\'s wakes are never printed; its end itself still is', async () => {
    const world = connected()
    const held = [{ type: 'held_for_step', holds: ['check_job'], connection_id: CONN, note: '0123456789abcdef', read_with: 'cat ~/.devspec/notes/0123456789abcdef.md', instruction: 'Read it.' }]
    const own = [{ type: 'turn_recall', for: 'm1', connection_id: CONN, read: 'cat ~/.devspec/notes/fedcba9876543210.md', note: 'DevSpec recall' }]
    const ended = [{ type: 'session_ended', reason: 'local_stop', connection_id: CONN }]
    for (const wake of [command(1), held, own, ended]) world.append(wake)
    world.end()
    const { printed, page } = await world.read()
    assert.equal(printed, readerHeader(2, 0) + wakeLines(command(1)) + wakeLines(ended))
    assert.equal(page.through, 4, 'read through, never to come again')
    assert.equal((await world.read()).printed, readerHeader(0, 0, NOTHING_UNREAD))
  })

  it('reads at the same time never both print, or both skip, the same wake', async () => {
    const world = connected()
    const wakes = [1, 2, 3, 4, 5, 6].map((n) => commandOfLength(7_000, n))
    for (const wake of wakes) world.append(wake)
    const runs = Array.from({ length: 4 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, [realScript, 'read', '--file', world.file], { env: { PATH: process.env.PATH, HOME: world.home } })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.once('close', (code) => resolve({ code, stdout }))
    }))
    const outputs = await Promise.all(runs)
    const printed = []
    for (const { code, stdout } of outputs) {
      assert.equal(code, 0)
      assert.ok(fitsShellOutput(stdout))
      printed.push(...splitWakes(parsed(stdout).wakes).wakes)
    }
    assert.deepEqual(printed.sort(), wakes.map(wakeLines).sort(), 'each wake exactly once')
  })
})

/** The real tail on `file`, started through `script`: what it has printed so far, whether it has exited, and how to stop it. */
function startTail(script, file, home) {
  const child = spawn(process.execPath, [script, '--file', file], { env: { PATH: process.env.PATH, HOME: home }, windowsHide: true })
  let stdout = ''
  let stderr = ''
  let exit = null
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const closed = new Promise((resolve) => child.once('close', (code) => { exit = code; resolve(code) }))
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    lines: () => stdout.split('\n').filter(Boolean),
    /** The exit code once it has exited by itself (and its output is all in), else null. */
    exit: () => exit,
    async stop() {
      if (exit === null) child.kill()
      await closed
    },
  }
}

describe('the background tail: notification lines only', () => {
  async function assertTailNotifiesVia(script) {
    const world = connected()
    const tail = startTail(script, world.file, world.home)
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.equal(tail.child.exitCode, null, `tail exited early via ${script}`)
      const events = command(1, 'THE-BODY: 1+1')
      world.append(events)
      assert.ok(await until(() => tail.lines().length >= 1), 'no notification line')
      const [line] = tail.lines()
      assert.match(line, NOTIFY, 'Cursor notifies on it')
      assert.ok(!tail.stdout().includes('THE-BODY'), 'never the wake itself')
      const said = JSON.parse(line)
      assert.deepEqual(said, { type: 'unread_wake', carries: ['owner_message'], read_with: readerCommand(world.file, { scriptPath: script }), note: NOTIFY_NOTE })
      assert.equal(tail.child.exitCode, null, 'still running')
      // The command it names is the reader, as it stands: run through a shell, it prints the wake whole.
      if (process.platform !== 'win32') {
        const run = spawnSync('sh', ['-c', said.read_with], { env: { PATH: process.env.PATH, HOME: world.home }, encoding: 'utf8' })
        assert.equal(run.status, 0, run.stderr)
        assert.equal(run.stdout, readerHeader(1, 0) + wakeLines(events))
      }
    } finally {
      await tail.stop()
    }
  }

  it('prints one line per new wake, naming the reader, and keeps running', async () => {
    await assertTailNotifiesVia(realScript)
  })

  it('stays alive when spawned through a ProgramData-style junction, and names the reader by that path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wake-pin-'))
    roots.push(tmp)
    const pin = path.join(tmp, 'pin')
    fs.symlinkSync(scriptsDir, pin, process.platform === 'win32' ? 'junction' : 'dir')
    await assertTailNotifiesVia(path.join(pin, 'devspec-wake-tail.mjs'))
  })

  it('its output holds only lines that match the wake filter and name the reader, never a wake body, however large', async () => {
    const world = connected()
    const wakes = [
      commandOfLength(19_950, 1),
      notice('n1'),
      [...command(2, 'BODY-TWO'), RECALL_IN_NEXT_WAKE],
      // A recall's own wake: the filter never matched it, so it raises no line.
      [{ type: 'turn_recall', for: 'm2', connection_id: CONN, read: 'cat ~/.devspec/notes/fedcba9876543210.md', note: 'DevSpec recall' }],
      [{ type: 'check_job', check_job_id: 'j1', instruction: 'BODY-CHECK' }, { type: 'wake', count: 1 }],
      [{ type: 'wake_in_note', carries: ['owner_message', 'wake'], read: 'cat ~/.devspec/notes/0123456789abcdef.md', note: 'whole in a file' }],
    ]
    const tail = startTail(realScript, world.file, world.home)
    try {
      for (const wake of wakes) world.append(wake)
      assert.ok(await until(() => tail.lines().length >= 5), tail.stdout())
      await new Promise((resolve) => setTimeout(resolve, 600))
      const lines = tail.lines()
      assert.equal(lines.length, 5, 'one line for each wake the filter matches, and only those')
      for (const line of lines) {
        assert.match(line, NOTIFY)
        assert.ok(line.length < 1_000, `${line.length} characters`)
        const said = JSON.parse(line)
        assert.equal(said.type, 'unread_wake')
        assert.equal(said.read_with, readerCommand(world.file))
      }
      assert.deepEqual(lines.map((line) => JSON.parse(line).carries), [['owner_message'], ['system_notice'], ['owner_message'], ['check_job'], ['owner_message']])
      for (const body of ['aaaaaaaaaa', 'BODY-TWO', 'BODY-CHECK', 'Notice n1']) assert.ok(!tail.stdout().includes(body), `a wake body in the output: ${body}`)
    } finally {
      await tail.stop()
    }
  })

  it('matches the wake filter for exactly the wakes the filter matched before, once per wake', () => {
    const cases = [
      [command(1), ['owner_message']],
      [[...notice('n1').slice(0, 1), ...notice('n2')], ['system_notice']],
      [[{ type: 'question_answer', question_id: 'q1' }, { type: 'wake' }], ['question_answer']],
      [[{ type: 'question_dismissal', question_id: 'q1' }, { type: 'wake' }], ['question_dismissal']],
      [[{ type: 'session_ended', reason: 'signed_out' }], ['session_ended']],
      [[{ type: 'automation_dispatch', dispatch: { run_id: 'r1' } }, { type: 'wake' }], ['automation_dispatch']],
      [[{ type: 'check_job', check_job_id: 'j1' }, { type: 'wake' }], ['check_job']],
      [[{ type: 'held_for_step', holds: ['check_job', 'system_notice'], connection_id: CONN }], ['check_job', 'system_notice']],
      [[{ type: 'wake_in_note', carries: ['automation_dispatch', 'turn_recall', 'wake'] }], ['automation_dispatch']],
      [[{ type: 'turn_recall', for: 'm1', read: 'cat ~/.devspec/notes/0123456789abcdef.md' }], null],
      [[{ type: 'room_unread', unread: 2 }, { type: 'wake' }], null],
    ]
    for (const [events, carries] of cases) {
      const wake = wakeLines(events)
      const line = notifyLine(wake, 'node reader')
      assert.equal(line !== null, NOTIFY.test(wake), `the same decision as the filter on the wake itself: ${wake}`)
      if (carries === null) {
        assert.equal(line, null)
        continue
      }
      assert.equal(line.split('\n').filter(Boolean).length, 1, 'one line')
      assert.match(line, NOTIFY)
      assert.deepEqual(JSON.parse(line).carries, carries)
    }
  })

  it('raises no line for wakes the reader has already printed', async () => {
    const world = connected()
    world.append(command(1))
    world.append(notice('n1'))
    world.readCli()
    const tail = startTail(realScript, world.file, world.home)
    try {
      await new Promise((resolve) => setTimeout(resolve, 800))
      assert.equal(tail.stdout(), '', 'both read already')
      world.append(notice('n2'))
      assert.ok(await until(() => tail.lines().length === 1), tail.stdout())
      assert.deepEqual(JSON.parse(tail.lines()[0]).carries, ['system_notice'])
    } finally {
      await tail.stop()
    }
  })

  it('raises no line for a wake for a connection that has ended', async () => {
    const world = connected()
    world.end()
    world.append([{ type: 'held_for_step', holds: ['system_notice'], connection_id: CONN, note: '0123456789abcdef' }])
    const tail = startTail(realScript, world.file, world.home)
    try {
      await new Promise((resolve) => setTimeout(resolve, 800))
      assert.equal(tail.stdout(), '')
    } finally {
      await tail.stop()
    }
  })
})

/** Every wake the reader has left, read to the end as the agent does (again while `remaining` is above 0): the room commands' ids, in order, and each read's header. */
async function readAll(world, options = {}) {
  const ids = []
  const headers = []
  for (let reads = 0; reads < 200; reads += 1) {
    const { printed } = await world.read(options)
    const { header, wakes } = parsed(printed)
    headers.push(header)
    for (const line of wakes.split('\n').filter(Boolean)) {
      const event = JSON.parse(line)
      if (event.type === 'owner_message') ids.push(event.message_id)
    }
    if (header.devspec_wakes.remaining === 0) return { ids, headers }
  }
  throw new Error('the reader never finished')
}

/** `n` room commands, numbered from `from`, appended one wake each, as the host follow writes them. */
function appendCommands(world, from, n) {
  for (let i = from; i < from + n; i += 1) world.append(command(i, `B${i}`))
}

const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`)
/** A tail's lines for wakes announced for the first time, and its reminder line (`again`) for a backlog an earlier tail announced. */
const fresh = (tail) => tail.lines().filter((line) => !JSON.parse(line).again)
const again = (tail) => tail.lines().filter((line) => JSON.parse(line).again)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe("the listener hands over to a new one before Cursor's notification limit", () => {
  it('counts matches as Cursor does, never lines, and keeps one short of the limit', () => {
    assert.equal(LISTENER_MATCH_BUDGET, CURSOR_NOTIFY_MATCH_LIMIT - 1, "Cursor's own limit notification never comes")
    assert.ok(LISTENER_RELIEF_AT > 0 && LISTENER_RELIEF_AT < LISTENER_MATCH_BUDGET)
    const one = notifyLine(wakeLines(command(1)), readerCommand('/var/tmp/devspec-wakes/x.jsonl'))
    const two = notifyLine(wakeLines([{ type: 'held_for_step', holds: ['check_job', 'system_notice'], connection_id: CONN }]), 'node reader')
    assert.equal(notifyMatches(one), 1)
    assert.equal(notifyMatches(two), 2, 'a line naming two of its words counts two')
    assert.equal(notifyMatches('devspec-wake-tail: watching /var/tmp/devspec-wakes/x.jsonl'), 0)
  })

  it('stops one match short of the limit and exits; the reader then says to start the next, which announces exactly what the first did not, wakes that arrived in between included, and reminds once of what the first announced that is still unread', async () => {
    const world = connected()
    const first = startTail(realScript, world.file, world.home)
    let second = null
    try {
      await sleep(300)
      appendCommands(world, 1, LISTENER_MATCH_BUDGET + 1)
      assert.ok(await until(() => first.exit() !== null, 20_000), `still running after ${first.lines().length} lines`)
      assert.equal(first.exit(), 0)
      assert.equal(first.lines().length, LISTENER_MATCH_BUDGET, 'one line per wake up to the budget, none past it')
      assert.equal(notifyMatches(first.stdout()) + notifyMatches(first.stderr()), LISTENER_MATCH_BUDGET, 'fewer matches than Cursor allows, on stdout and stderr together')
      const lease = readListenerLease(world.file, CONN, world.dir)
      assert.equal(lease.state, 'retired')
      assert.equal(lease.announced_through, Buffer.byteLength(Array.from({ length: LISTENER_MATCH_BUDGET }, (_, i) => wakeLines(command(i + 1, `B${i + 1}`))).join('')))

      // Two more arrive while no listener runs; then the agent, sent to the reader by Cursor's exit notification, is told to start the next.
      appendCommands(world, LISTENER_MATCH_BUDGET + 2, 2)
      const advice = listenerAdvice(readListenerLease(world.file, CONN, world.dir), world.file)
      assert.deepEqual(advice, {
        status: 'stopped',
        start: listenerCommand(world.file),
        notify_on_output: { pattern: REMOTE_WAKE_NOTIFY_PATTERN, reason: LISTENER_REASON },
        note: LISTENER_STOPPED_NOTE,
      })
      second = startTail(realScript, world.file, world.home)
      assert.ok(await until(() => fresh(second).length >= 3), second.stdout())
      await sleep(600)
      assert.equal(fresh(second).length, 3, 'the one the first stopped before, and the two that came in between; nothing the first announced')
      // None of what the first announced has been read yet, so the new one says so once, for the earliest.
      assert.equal(again(second).length, 1)
      assert.equal(second.lines()[0], again(second)[0], 'before anything new')
      assert.deepEqual(JSON.parse(again(second)[0]).carries, ['owner_message'])
      appendCommands(world, LISTENER_MATCH_BUDGET + 4, 1)
      assert.ok(await until(() => fresh(second).length === 4), second.stdout())
      assert.equal(second.exit(), null, 'the new one keeps running')
      assert.doesNotMatch(second.stderr(), /taking over/, 'nothing was running to take over from')

      // Each wake was announced once across the two, and the reader hands each over once, whole.
      const total = LISTENER_MATCH_BUDGET + 4
      assert.equal(first.lines().length + fresh(second).length, total)
      const { ids: read, headers } = await readAll(world)
      assert.deepEqual(read, ids(1, total))
      for (const header of headers) assert.equal(header.listener, undefined, 'a running listener needs no replacing yet')
    } finally {
      await first.stop()
      await second?.stop()
    }
  })

  it('a next listener started after the agent has read announces only what arrives after that read', async () => {
    const world = connected()
    const first = startTail(realScript, world.file, world.home)
    let second = null
    try {
      await sleep(300)
      appendCommands(world, 1, LISTENER_MATCH_BUDGET + 1)
      assert.ok(await until(() => first.exit() !== null, 20_000))
      const { ids: read, headers } = await readAll(world)
      assert.deepEqual(read, ids(1, LISTENER_MATCH_BUDGET + 1), 'the reader hands over the wake the listener stopped before, too')
      assert.ok(headers.every((header) => header.listener?.status === 'stopped'), 'every read until a new listener runs says to start one')
      for (const header of headers) assert.ok(fitsShellOutput(JSON.stringify(header)))
      second = startTail(realScript, world.file, world.home)
      await sleep(800)
      assert.equal(second.stdout(), '', 'everything is read: nothing to announce, and no reminder')
      appendCommands(world, LISTENER_MATCH_BUDGET + 2, 1)
      assert.ok(await until(() => second.lines().length === 1), second.stdout())
      assert.deepEqual((await readAll(world)).ids, [`m${LISTENER_MATCH_BUDGET + 2}`])
    } finally {
      await first.stop()
      await second?.stop()
    }
  })

  it('counts a line that names two words as two: it stops when the next line would pass the budget', async () => {
    const world = connected()
    const first = startTail(realScript, world.file, world.home)
    try {
      await sleep(300)
      const both = (n) => [{ type: 'held_for_step', holds: ['check_job', 'system_notice'], connection_id: CONN, note: `${String(n).padStart(16, '0')}` }]
      for (let i = 0; i < LISTENER_MATCH_BUDGET; i += 1) world.append(both(i))
      assert.ok(await until(() => first.exit() !== null, 20_000))
      assert.equal(first.lines().length, Math.floor(LISTENER_MATCH_BUDGET / 2))
      assert.ok(notifyMatches(first.stdout()) <= LISTENER_MATCH_BUDGET)
      assert.ok(notifyMatches(first.stdout()) + 2 > LISTENER_MATCH_BUDGET, 'it stopped only when the next line would not fit')
    } finally {
      await first.stop()
    }
  })

  it('from halfway to the limit every read asks for a new listener; the new one takes over from the running one while wakes keep arriving, and each is announced once', async () => {
    const world = connected()
    const first = startTail(realScript, world.file, world.home)
    let second = null
    try {
      await sleep(300)
      appendCommands(world, 1, LISTENER_RELIEF_AT)
      assert.ok(await until(() => first.lines().length === LISTENER_RELIEF_AT), String(first.lines().length))
      assert.ok(await until(() => readListenerLease(world.file, CONN, world.dir)?.state === 'relief'))
      const asked = await readAll(world)
      assert.deepEqual(asked.ids, ids(1, LISTENER_RELIEF_AT))
      assert.ok(asked.headers.every((header) => header.listener?.status === 'replace' && header.listener.note === LISTENER_REPLACE_NOTE))
      assert.equal(asked.headers[0].listener.start, listenerCommand(world.file))
      assert.equal(first.exit(), null, 'the running one keeps announcing until it is replaced')

      // Wakes keep arriving, every few milliseconds, while the agent starts the new listener.
      const more = 200
      let appended = 0
      const arriving = (async () => {
        for (; appended < more; appended += 1) {
          world.append(command(LISTENER_RELIEF_AT + 1 + appended, `B${LISTENER_RELIEF_AT + 1 + appended}`))
          await sleep(4)
        }
      })()
      await until(() => appended >= 50)
      second = startTail(realScript, world.file, world.home)
      await arriving
      assert.ok(await until(() => first.exit() !== null), 'the old listener stops by itself')
      assert.equal(first.exit(), 0)
      assert.match(first.stderr(), new RegExp(`the listener in process ${second.child.pid} has taken over`))
      assert.match(second.stderr(), new RegExp(`taking over from the listener in process ${first.child.pid}`))
      const total = LISTENER_RELIEF_AT + more
      assert.ok(await until(() => first.lines().length + fresh(second).length >= total), `${first.lines().length} + ${fresh(second).length}`)
      await sleep(600)
      assert.equal(first.lines().length + fresh(second).length, total, 'every wake announced once between the two: none lost, none twice')
      assert.ok(again(second).length <= 1, 'at most one reminder, for wakes the first announced that were still unread at the switch')
      assert.ok(fresh(second).length > 0, 'the new one announced what came after the switch')
      const rest = await readAll(world)
      assert.deepEqual(rest.ids, ids(LISTENER_RELIEF_AT + 1, total))
      for (const header of rest.headers) assert.equal(header.listener, undefined, 'the new listener is far from the limit')
    } finally {
      await first.stop()
      await second?.stop()
    }
  })

  it('never two listeners: one started beside a running one that was not handing over takes over at once, and the first stops without printing again; an unread wake it had announced is announced again, never lost', async () => {
    const world = connected()
    const first = startTail(realScript, world.file, world.home)
    let second = null
    try {
      await sleep(300)
      appendCommands(world, 1, 1)
      assert.ok(await until(() => first.lines().length === 1))
      second = startTail(realScript, world.file, world.home)
      assert.ok(await until(() => first.exit() !== null), 'the first stops at its next look')
      assert.ok(await until(() => second.lines().length === 1), 'the unread wake, announced again')
      assert.equal(again(second).length, 0, 'announced as new: the first was not handing over, so the second starts after what was read')
      appendCommands(world, 2, 1)
      assert.ok(await until(() => second.lines().length === 2))
      await sleep(400)
      assert.equal(first.lines().length, 1, 'nothing printed by the first after the second took over')
      assert.deepEqual((await readAll(world)).ids, ['m1', 'm2'], 'and the reader hands each over once')
    } finally {
      await first.stop()
      await second?.stop()
    }
  })

  it('a burst of wakes, which Cursor folds into one notification showing only the latest, reaches the agent whole from one read', async () => {
    const world = connected()
    const first = startTail(realScript, world.file, world.home)
    try {
      await sleep(300)
      const burst = [command(1), notice('n1'), [{ type: 'check_job', check_job_id: 'j1', instruction: 'BODY-CHECK' }, { type: 'wake', count: 1 }]]
      for (const wake of burst) world.append(wake)
      assert.ok(await until(() => first.lines().length === 3))
      // Cursor's notification would name only the last line's word; whatever it names, the agent runs the reader.
      assert.deepEqual(JSON.parse(first.lines().at(-1)).carries, ['check_job'])
      const { printed } = await world.read()
      assert.equal(printed, readerHeader(3, 0) + burst.map(wakeLines).join(''))
      assert.equal((await world.read()).printed, readerHeader(0, 0, NOTHING_UNREAD), 'a later notification for the same burst finds nothing new')
    } finally {
      await first.stop()
    }
  })

  it('the reader names a listener to start only when one is needed', async () => {
    const world = connected()
    const write = (lease) => fs.writeFileSync(listenerLeasePath(CONN, world.dir), JSON.stringify({ version: 1, file: path.resolve(world.file), ...lease }))
    const header = async (isAlive) => parsed((await world.read({ isAlive })).printed).header
    world.append(command(1))
    assert.equal((await header(() => true)).listener, undefined, 'no lease: no listener of this version has run')
    write({ pid: 4242, state: 'listening', matches: 3, announced_through: 0 })
    assert.equal((await header(() => true)).listener, undefined, 'a running listener far from the limit')
    assert.equal((await header(() => false)).listener.status, 'stopped', 'its process is gone')
    write({ pid: 4242, state: 'relief', matches: LISTENER_RELIEF_AT, announced_through: 0 })
    assert.equal((await header(() => true)).listener.status, 'replace')
    write({ pid: 4242, state: 'retired', matches: LISTENER_MATCH_BUDGET, announced_through: 0 })
    assert.equal((await header(() => true)).listener.status, 'stopped')
    fs.writeFileSync(listenerLeasePath(CONN, world.dir), JSON.stringify({ version: 1, file: '/elsewhere.jsonl', pid: 4242, state: 'retired' }))
    assert.equal((await header(() => true)).listener, undefined, "another file's lease says nothing about this one")
  })

  it('a page that says to start a listener still fits one Shell output, its wakes whole', () => {
    const listener = listenerAdvice({ pid: 1, state: 'retired' }, '/var/tmp/devspec-wakes/6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f.jsonl')
    const wakes = [wakeLines(commandOfLength(CURSOR_SHELL_OUTPUT_MAX_CHARS - readerHeader(1, 1).length, 1)), wakeLines(command(2))]
    const page = readerPage(wakes, { listener, home: connected().home })
    assert.ok(fitsShellOutput(page.text))
    assert.equal(JSON.parse(page.text.slice(0, page.text.indexOf('\n'))).listener.status, 'stopped')
    assert.equal(page.printed + page.remaining, 2)
  })

  it('where a new listener starts: after what a handing-over listener announced, else after what the reader printed', () => {
    assert.equal(startOffset(null, 40, 100), 40)
    assert.equal(startOffset({ state: 'listening', announced_through: 90 }, 40, 100), 40)
    assert.equal(startOffset({ state: 'relief', announced_through: 90 }, 40, 100), 90)
    assert.equal(startOffset({ state: 'retired', announced_through: 90 }, 95, 100), 95)
    assert.equal(startOffset({ state: 'retired', announced_through: 90 }, 40, 50), 0, 'a file shorter than both starts again from its beginning')
  })
})
