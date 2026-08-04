import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  compareSemverTuples,
  parseExtensionVersion,
  resolveInstalledMirrorTurn,
  stableMirrorTurnPath,
} from './run-mirror-turn.mjs'

describe('parseExtensionVersion', () => {
  it('parses dotted versions', () => {
    assert.deepEqual(parseExtensionVersion('devspecai.devspec-autopilot-0.4.7'), [0, 4, 7])
  })

  it('returns empty for unrelated dirs', () => {
    assert.deepEqual(parseExtensionVersion('other-ext-1.0.0'), [])
  })
})

describe('compareSemverTuples', () => {
  it('orders by major/minor/patch', () => {
    assert.ok(compareSemverTuples([0, 4, 7], [0, 4, 5]) > 0)
    assert.ok(compareSemverTuples([0, 3, 14], [0, 4, 0]) < 0)
    assert.equal(compareSemverTuples([0, 4, 7], [0, 4, 7]), 0)
  })
})

describe('resolveInstalledMirrorTurn', () => {
  it('picks the highest version that still has mirror-turn.mjs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mirror-resolve-'))
    try {
      const ext = path.join(home, '.cursor', 'extensions')
      const mk = (ver, withScript) => {
        const dir = path.join(ext, `devspecai.devspec-autopilot-${ver}`)
        const scriptDir = path.join(dir, 'hooks', 'scripts')
        fs.mkdirSync(scriptDir, { recursive: true })
        if (withScript) {
          fs.writeFileSync(path.join(scriptDir, 'mirror-turn.mjs'), '// stub\n')
        }
      }
      mk('0.4.5', true)
      mk('0.4.7', true)
      mk('0.3.14', false)
      const resolved = resolveInstalledMirrorTurn(home)
      assert.ok(resolved)
      assert.match(resolved, /0\.4\.7/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null when nothing is installed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mirror-empty-'))
    try {
      fs.mkdirSync(path.join(home, '.cursor', 'extensions'), { recursive: true })
      assert.equal(resolveInstalledMirrorTurn(home), null)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('stableMirrorTurnPath', () => {
  it('is under ~/.cursor/devspec/hooks', () => {
    const p = stableMirrorTurnPath('/tmp/home')
    assert.equal(p, path.join('/tmp/home', '.cursor', 'devspec', 'hooks', 'run-mirror-turn.mjs'))
  })
})
