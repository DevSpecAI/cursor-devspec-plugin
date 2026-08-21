import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendWakeEvents,
  ensureWakeFile,
  pathHasWhitespace,
  resolveSpaceFreeWakeFile,
} from './devspec-wake-file.mjs'

const ID = '9fe6ce6b-01e3-40a4-b6c3-1f0be48d10f6'

describe('resolveSpaceFreeWakeFile', () => {
  it('Windows path is under ProgramData/DevSpec/wakes and has no whitespace', () => {
    const file = resolveSpaceFreeWakeFile(ID, {
      platform: 'win32',
      programData: 'C:\\ProgramData',
    })
    assert.equal(file, path.join('C:\\ProgramData', 'DevSpec', 'wakes', `${ID}.jsonl`))
    assert.equal(pathHasWhitespace(file), false)
  })

  it('rejects a non-uuid connection id (path traversal)', () => {
    assert.throws(() => resolveSpaceFreeWakeFile('../etc/passwd', { platform: 'win32' }))
    assert.throws(() => resolveSpaceFreeWakeFile('not-a-uuid', { platform: 'linux' }))
  })

  it('POSIX path is under /var/tmp and has no whitespace', () => {
    const file = resolveSpaceFreeWakeFile(ID, { platform: 'linux' })
    assert.equal(file, path.join('/var/tmp/devspec-wakes', `${ID}.jsonl`))
    assert.equal(pathHasWhitespace(file), false)
  })
})

describe('ensureWakeFile / appendWakeEvents', () => {
  it('creates the file and appends one JSON line per event', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wake-'))
    const file = path.join(dir, `${ID}.jsonl`)
    try {
      ensureWakeFile(file)
      assert.equal(fs.readFileSync(file, 'utf8'), '')
      appendWakeEvents(file, [
        { type: 'owner_message', message: { id: 'm1' } },
        { type: 'wake', reason: 'canonical_conversational_command' },
      ])
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.trim().split('\n')
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).type, 'owner_message')
      assert.equal(JSON.parse(lines[1]).type, 'wake')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
