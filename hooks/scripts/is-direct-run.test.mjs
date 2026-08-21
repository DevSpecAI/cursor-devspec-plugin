import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectRun } from './is-direct-run.mjs'

describe('isDirectRun', () => {
  it('matches the real path and a junction/symlink to the same file', () => {
    const real = fileURLToPath(import.meta.url)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-is-direct-run-'))
    const pin = path.join(tmp, 'pin')
    try {
      fs.symlinkSync(path.dirname(real), pin, process.platform === 'win32' ? 'junction' : 'dir')
      const viaPin = path.join(pin, path.basename(real))
      assert.equal(isDirectRun(import.meta.url, real), true)
      assert.equal(isDirectRun(import.meta.url, viaPin), true)
      assert.equal(isDirectRun(import.meta.url, path.join(pin, 'other.mjs')), false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
