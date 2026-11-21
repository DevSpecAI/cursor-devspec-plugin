import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const realScript = fileURLToPath(new URL('./devspec-wake-tail.mjs', import.meta.url))
const scriptsDir = path.dirname(realScript)

async function assertTailPrintsVia(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wake-tail-'))
  const file = path.join(dir, 'wake.jsonl')
  fs.writeFileSync(file, '')
  const child = spawn(process.execPath, [script, '--file', file], {
    windowsHide: true,
  })
  let stdout = ''
  child.stdout.on('data', (d) => {
    stdout += d.toString()
  })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(child.exitCode, null, `tail exited early via ${script}`)
  fs.appendFileSync(file, `${JSON.stringify({ type: 'owner_message', message: { text: '1+1' } })}\n`)
  const deadline = Date.now() + 8000
  try {
    while (Date.now() < deadline && !stdout.includes('owner_message')) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.match(stdout, /"type":"owner_message"/)
    assert.equal(child.exitCode, null)
  } finally {
    child.kill()
    await new Promise((r) => child.once('close', r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('devspec-wake-tail', () => {
  it('prints new wake lines without exiting', async () => {
    await assertTailPrintsVia(realScript)
  })

  it('stays alive when spawned through a ProgramData-style junction', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wake-pin-'))
    const pin = path.join(tmp, 'pin')
    try {
      fs.symlinkSync(scriptsDir, pin, process.platform === 'win32' ? 'junction' : 'dir')
      await assertTailPrintsVia(path.join(pin, 'devspec-wake-tail.mjs'))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('what one print of the wake tail hands Cursor', () => {
  // Imported here, in the tail's own test, only for its pure parts.
  const load = async () => ({
    ...(await import('./devspec-wake-tail.mjs')),
    ...(await import('./devspec-wake-file.mjs')),
    ...(await import('./hook-context-budget.mjs')),
    ...(await import('./turn-recall.mjs')),
  })

  /** A room command's wake of about `chars` characters, as the wait builds it, with a recall placed by the plugin's sizer. */
  function commandWake(mod, chars, n, home) {
    const event = (body) => [
      { type: 'owner_message', message_id: `m${n}`, body, session_id: 's1' },
      { type: 'wake', reason: 'canonical_conversational_command', session_id: 's1', count: 1 },
    ]
    const bare = mod.wakeLines(event('')).length
    const command = event('a'.repeat(chars - bare))
    const recall = {
      version: 1,
      // Too long to go inline beside a ~10,000-character command, so it goes as a pointer.
      formatted_block: `== PROACTIVE PROJECT RECALL ==\n${Array.from({ length: 160 }, (_, i) => `- [REQUIREMENT] **Requirement ${n}.${i}** governs the settings page redirect (get_requirement({ id: "${i}" }))`).join('\n')}`,
      seen_keys: [`memory:00000000-0000-4000-8000-00000000000${n}:v1`],
    }
    return { command, withRecall: mod.withTurnRecall(command, recall, { home }) }
  }

  it('two wakes that fit together without recall, and each fit with its recall pointer, go out in two prints, each within the limit, nothing lost', async () => {
    const mod = await load()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wake-tail-fit-'))
    try {
      const a = commandWake(mod, 9_990, 1, home)
      const b = commandWake(mod, 9_990, 2, home)
      // DevSpec's case: together they fit without recall; each fits with its pointer; together with both, they do not.
      assert.ok(mod.fitsShellOutput(mod.wakeLines(a.command) + mod.wakeLines(b.command)))
      for (const each of [a, b]) {
        assert.ok(each.withRecall.some((event) => event.type === 'turn_recall' && event.read), 'each carries a pointer')
        assert.ok(mod.fitsShellOutput(mod.wakeLines(each.withRecall)))
      }
      const file = mod.wakeLines(a.withRecall) + mod.wakeLines(b.withRecall)
      assert.equal(mod.fitsShellOutput(file), false)

      const first = mod.nextOutput(file)
      assert.equal(first, mod.wakeLines(a.withRecall))
      const second = mod.nextOutput(file.slice(first.length))
      assert.equal(second, mod.wakeLines(b.withRecall))
      assert.equal(first + second, file, 'nothing lost, nothing split')
      assert.equal(mod.nextOutput(''), '')
      // A wake still being written is not printed until it is whole.
      assert.equal(mod.nextOutput(mod.wakeLines(a.withRecall).slice(0, -1)), '')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('prints a single wake over the limit on its own, as it always did, and lines with no boundary once the file stops growing', async () => {
    const mod = await load()
    const over = mod.wakeLines([{ type: 'owner_message', body: 'x'.repeat(25_000) }, { type: 'wake' }])
    const small = mod.wakeLines([{ type: 'system_notice', notice_id: 'n1' }, { type: 'wake' }])
    assert.equal(mod.nextOutput(over + small), over)
    assert.equal(mod.nextOutput(small), small)
    const legacy = `${JSON.stringify({ type: 'owner_message', body: 'old' })}\n${JSON.stringify({ type: 'wake' })}\n`
    assert.equal(mod.nextOutput(legacy), '', 'maybe still being written')
    assert.equal(mod.nextOutput(legacy, { settled: true }), legacy)
  })

  it('as a running tail: the two wakes come out in separate prints, each within the limit', async () => {
    const mod = await load()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wake-tail-run-'))
    const file = path.join(home, 'wake.jsonl')
    try {
      const a = commandWake(mod, 9_990, 1, home)
      const b = commandWake(mod, 9_990, 2, home)
      mod.appendWakeEvents(file, a.withRecall)
      mod.appendWakeEvents(file, b.withRecall)
      const child = spawn(process.execPath, [realScript, '--file', file], { windowsHide: true })
      const chunks = []
      child.stdout.on('data', (d) => chunks.push({ at: Date.now(), text: d.toString() }))
      const expected = fs.readFileSync(file, 'utf8')
      const deadline = Date.now() + 8000
      try {
        while (Date.now() < deadline && chunks.map((c) => c.text).join('') !== expected) await new Promise((r) => setTimeout(r, 50))
      } finally {
        child.kill()
        await new Promise((r) => child.once('close', r))
      }
      assert.equal(chunks.map((c) => c.text).join(''), expected, 'nothing lost')
      // Pipe chunks of one print arrive together; prints are a poll (250 ms) apart.
      const prints = []
      for (const chunk of chunks) {
        if (prints.length > 0 && chunk.at - prints.at(-1).at < 150) prints.at(-1).text += chunk.text
        else prints.push({ ...chunk })
      }
      assert.equal(prints.length, 2, prints.map((p) => p.text.length).join(', '))
      for (const print of prints) assert.ok(mod.fitsShellOutput(print.text), `${print.text.length} characters in one print`)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
