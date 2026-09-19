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

// Every hook event Cursor documents. An event name outside this set does not
// simply get ignored: Cursor validates the whole hooks.json and loads NONE of
// it, so one wrong key silently disables every other hook in the file. That is
// how the packaged config shipped with `Stop` / `UserPromptSubmit` (Claude Code
// names) and every Cursor hook we ship was dead (item 1b021c9e).
const CURSOR_HOOK_EVENTS = new Set([
  'sessionStart', 'sessionEnd',
  'preToolUse', 'postToolUse', 'postToolUseFailure',
  'subagentStart', 'subagentStop',
  'beforeShellExecution', 'afterShellExecution',
  'beforeMCPExecution', 'afterMCPExecution',
  'beforeReadFile', 'afterFileEdit',
  'beforeSubmitPrompt', 'preCompact', 'stop',
  'afterAgentResponse', 'afterAgentThought',
  'beforeTabFileRead', 'afterTabFileEdit',
  'workspaceOpen',
])

describe('Cursor hooks.json stays loadable by Cursor', () => {
  const packaged = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))

  it('the packaged config uses only event names Cursor knows', () => {
    for (const event of Object.keys(packaged.hooks)) {
      assert.ok(
        CURSOR_HOOK_EVENTS.has(event),
        `"${event}" is not a Cursor hook event. Cursor rejects the entire hooks.json on an unknown key, so this disables EVERY hook in the file, not just this one.`,
      )
    }
  })

  it('the packaged config uses Cursor\'s flat entry shape, not Claude Code\'s nested one', () => {
    for (const [event, entries] of Object.entries(packaged.hooks)) {
      assert.ok(Array.isArray(entries), `${event} must be an array`)
      for (const entry of entries) {
        assert.equal(
          Array.isArray(entry.hooks),
          false,
          `${event} uses Claude Code's nested { hooks: [...] } wrapper. Cursor expects a flat [{ command }] entry and fires nothing for the nested form — verified against cursor-agent 2026.08.11.`,
        )
        assert.equal(typeof entry.command, 'string', `${event} entry needs a command`)
      }
    }
  })

  it('the merged ~/.cursor/hooks.json never gains an event name Cursor does not know', () => {
    const merged = mergeCursorHookConfig({}, '/stable/run-mirror-turn.mjs')
    for (const event of Object.keys(merged.hooks)) {
      assert.ok(CURSOR_HOOK_EVENTS.has(event), `merge emitted unknown Cursor event "${event}"`)
    }
  })

  it('removes a legacy Claude-named key it had previously written, rather than leaving it empty', () => {
    // An install from before the fix: our own entries under Claude Code names.
    const poisoned = {
      version: 1,
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node /old/run-mirror-turn.mjs stop # devspec-remote-mirror' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /old/run-mirror-turn.mjs user_prompt # devspec-remote-mirror' }] }],
      },
    }
    const merged = mergeCursorHookConfig(poisoned, '/stable/run-mirror-turn.mjs')
    assert.equal('Stop' in merged.hooks, false, 'an emptied "Stop" key still breaks the whole file')
    assert.equal('UserPromptSubmit' in merged.hooks, false)
    // The work those keys were doing has moved to the Cursor-named events.
    assert.equal(commandsFor(merged, 'stop').some((c) => / stop # devspec-remote-mirror$/.test(c)), true)
    assert.equal(commandsFor(merged, 'beforeSubmitPrompt').some((c) => / user_prompt # devspec-remote-mirror$/.test(c)), true)
  })

  it('leaves a third party\'s entries under a legacy key alone', () => {
    const theirs = { hooks: [{ type: 'command', command: 'node /third-party/stop.mjs' }] }
    const merged = mergeCursorHookConfig({ version: 1, hooks: { Stop: [theirs] } }, '/stable/run-mirror-turn.mjs')
    assert.deepEqual(merged.hooks.Stop, [theirs], 'deleting someone else\'s hooks is not ours to do')
  })
})
