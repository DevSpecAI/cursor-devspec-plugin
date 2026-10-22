#!/usr/bin/env node
/**
 * Cursor ending a turn with an error clears Working (item 45eb0708).
 * Run: node --test hooks/scripts/turn-error-end.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { erroredTurnEnd, erroredTurnNotice } from './turn-error-end.mjs'

const LIMIT = "You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more."
const scratch = []
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }) })

function transcript(lines, { mtime } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-error-end-'))
  scratch.push(dir)
  const file = path.join(dir, 't.jsonl')
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}
const ERRORED = { type: 'turn_ended', status: 'error', error: LIMIT }

describe('erroredTurnEnd', () => {
  const startedAt = Date.parse('2026-10-20T19:34:00Z')
  const after = Date.parse('2026-10-20T19:35:00Z')

  it('sees Cursor ending the current turn with its usage limit, even under an enormous preceding line', () => {
    const huge = JSON.stringify({ type: 'assistant', text: 'x'.repeat(200_000) })
    const file = transcript([huge, ERRORED], { mtime: after })
    assert.deepEqual(erroredTurnEnd({ transcriptPath: file, startedAt }), { error: LIMIT })
  })

  it('never lets an errored end from an earlier turn end a newer one', () => {
    const before = transcript([ERRORED], { mtime: startedAt - 60_000 })
    assert.equal(erroredTurnEnd({ transcriptPath: before, startedAt }), null)
    const resumed = transcript([ERRORED, { type: 'user', text: 'try again' }], { mtime: after })
    assert.equal(erroredTurnEnd({ transcriptPath: resumed, startedAt }), null)
  })

  it('ignores clean turn ends, a missing transcript and a half-written last line', () => {
    assert.equal(erroredTurnEnd({ transcriptPath: transcript([{ type: 'turn_ended', status: 'ok' }], { mtime: after }), startedAt }), null)
    assert.equal(erroredTurnEnd({ transcriptPath: '/nonexistent/t.jsonl', startedAt }), null)
    assert.equal(erroredTurnEnd({ transcriptPath: transcript(['{"type":"turn_ended","status":"er'], { mtime: after }), startedAt }), null)
  })
})

describe('erroredTurnNotice', () => {
  it('says what stopped, quotes Cursor, and says what to do', () => {
    const notice = erroredTurnNotice({ error: LIMIT })
    assert.match(notice, /Cursor stopped/)
    assert.ok(notice.includes(LIMIT))
    assert.match(notice, /send your message again/)
  })
})
