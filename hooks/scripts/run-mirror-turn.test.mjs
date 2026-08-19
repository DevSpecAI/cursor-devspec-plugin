import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  compareSemverTuples,
  hookChildExitCode,
  parseExtensionVersion,
  resolveInstalledHookScript,
  resolveInstalledMirrorTurn,
  resolveHookInvocation,
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

describe('resolveHookInvocation', () => {
  it('routes installed provenance hooks separately from trail hooks', () => {
    assert.deepEqual(resolveHookInvocation('provenance-preToolUse'), {
      mode: 'preToolUse',
      scriptName: 'provenance-assistance.mjs',
    })
    assert.deepEqual(resolveHookInvocation('provenance-afterMCPExecution'), {
      mode: 'afterMCPExecution',
      scriptName: 'provenance-assistance.mjs',
    })
    assert.deepEqual(resolveHookInvocation('afterMCPExecution'), {
      mode: 'afterMCPExecution',
      scriptName: 'trail-turn.mjs',
    })
  })
})

describe('hookChildExitCode', () => {
  it('fails provenance launch errors open without changing trail/remote behavior', () => {
    assert.equal(hookChildExitCode('provenance-assistance.mjs', { status: 1 }), 0)
    assert.equal(hookChildExitCode('provenance-assistance.mjs', { status: null, error: new Error('spawn') }), 0)
    assert.equal(hookChildExitCode('trail-turn.mjs', { status: 1 }), 1)
    assert.equal(hookChildExitCode('mirror-turn.mjs', { status: null }), 1)
  })
})

describe('stable provenance launcher output', () => {
  it('forwards a decision only when the provenance child exits successfully', () => {
    const script = fileURLToPath(new URL('./run-mirror-turn.mjs', import.meta.url))
    for (const { exitCode, expected } of [{ exitCode: 0, expected: '{"permission":"allow"}\n' }, { exitCode: 1, expected: '' }]) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-provenance-launch-'))
      try {
        const childDir = path.join(home, '.cursor', 'extensions', 'devspecai.devspec-autopilot-9.9.9', 'hooks', 'scripts')
        fs.mkdirSync(childDir, { recursive: true })
        fs.writeFileSync(path.join(childDir, 'provenance-assistance.mjs'),
          `process.stdout.write('{"permission":"allow"}\\n'); process.exit(${exitCode})\n`)
        const result = spawnSync(process.execPath, [script, 'provenance-preToolUse'], {
          encoding: 'utf8', env: { ...process.env, HOME: home }, input: '{}',
        })
        assert.equal(result.status, 0)
        assert.equal(result.stdout, expected)
        if (exitCode) assert.match(result.stderr, /failed open/i)
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  })
})

describe('resolveInstalledHookScript', () => {
  it('resolves trail-turn.mjs from the newest install', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-resolve-'))
    try {
      const ext = path.join(home, '.cursor', 'extensions')
      const dir = path.join(ext, 'devspecai.devspec-autopilot-0.4.12')
      const scriptDir = path.join(dir, 'hooks', 'scripts')
      fs.mkdirSync(scriptDir, { recursive: true })
      fs.writeFileSync(path.join(scriptDir, 'trail-turn.mjs'), '// stub\n')
      const resolved = resolveInstalledHookScript('trail-turn.mjs', home)
      assert.ok(resolved)
      assert.match(resolved, /trail-turn\.mjs$/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
