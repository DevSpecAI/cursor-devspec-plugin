import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { mergeCursorHookConfig } from '../src/hook-config.cjs'

function commandsFor(config, event) {
  return (config.hooks?.[event] || []).flatMap((entry) =>
    Array.isArray(entry.hooks)
      ? entry.hooks.map((hook) => hook.command)
      : [entry.command],
  ).filter(Boolean)
}

describe('Cursor hook config merge', () => {
  it('adds Cursor hooks config version 1 on a fresh install without downgrading an existing version', () => {
    assert.equal(mergeCursorHookConfig({}, '/stable/run-mirror-turn.mjs').version, 1)
    assert.equal(mergeCursorHookConfig({ version: 2 }, '/stable/run-mirror-turn.mjs').version, 2)
  })

  it('is idempotent, upgrades DevSpec entries, and preserves third-party hooks', () => {
    const thirdParty = { command: 'node /third-party/check.mjs', matcher: '*.ts' }
    const thirdPartyMirror = { command: 'node /third-party/mirror-turn.mjs' }
    const input = {
      custom: { keep: true },
      hooks: {
        beforeShellExecution: [
          thirdParty,
          thirdPartyMirror,
          { command: 'node /old/run-mirror-turn.mjs beforeShellExecution # devspec-remote-mirror' },
        ],
        afterFileEdit: [{ command: 'node /third-party/audit.mjs' }],
        Stop: [{ hooks: [{ type: 'command', command: 'node /third-party/stop.mjs' }] }],
      },
    }

    const once = mergeCursorHookConfig(input, '/stable/run-mirror-turn.mjs')
    const twice = mergeCursorHookConfig(once, '/stable/run-mirror-turn.mjs')
    assert.deepEqual(twice, once)
    assert.deepEqual(once.custom, { keep: true })
    assert.deepEqual(once.hooks.beforeShellExecution.slice(0, 2), [thirdParty, thirdPartyMirror])
    assert.ok(commandsFor(once, 'afterFileEdit').includes('node /third-party/audit.mjs'))
    assert.ok(commandsFor(once, 'Stop').includes('node /third-party/stop.mjs'))

    const beforeShell = commandsFor(once, 'beforeShellExecution')
    assert.equal(beforeShell.filter((command) => / beforeShellExecution #/.test(command)).length, 1)
    assert.equal(beforeShell.some((command) => command.includes('mutation-')), false)
    assert.equal(commandsFor(once, 'preToolUse').filter((command) => command.includes('provenance-preToolUse')).length, 1)
    assert.equal(commandsFor(once, 'postToolUse').filter((command) => command.includes('provenance-postToolUse')).length, 1)
    assert.equal(commandsFor(once, 'afterMCPExecution').filter((command) => command.includes('provenance-afterMCPExecution')).length, 1)
    assert.equal(commandsFor(once, 'afterFileEdit').some((command) => command.includes('provenance-')), false)
    assert.equal(JSON.stringify(once).includes('/old/run-mirror-turn.mjs'), false)
  })

  it('keeps packaged provenance assistance wired without restoring mutation gates', () => {
    const packaged = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
    assert.equal(packaged.version, 1)
    for (const event of ['preToolUse', 'postToolUse', 'afterMCPExecution']) {
      assert.equal(commandsFor(packaged, event).some((command) => command.includes('provenance-assistance.mjs')), true, event)
    }
    for (const event of ['beforeShellExecution', 'postToolUse', 'afterMCPExecution', 'afterFileEdit']) {
      assert.equal(commandsFor(packaged, event).some((command) => command.includes('trail-turn.mjs')), true, event)
    }
    for (const event of ['postToolUse', 'afterMCPExecution']) {
      assert.equal(commandsFor(packaged, event).some((command) => command.includes('mark-explicit-reply.mjs')), true, event)
    }
    assert.equal(JSON.stringify(packaged).includes('mutation-boundary.mjs'), false)
  })
})
