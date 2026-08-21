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
