#!/usr/bin/env node
/**
 * Unit tests for Windows CLI agent spawn quoting / invocation.
 * Run: node --test scripts/launch-cli-session.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  buildInteractiveCursorAgentFlags,
  flattenPromptForArgv,
  inferCursorAgentRunKindFromPrompt,
  quoteWinCmdArg,
  resolveShellExecutable,
  resolveWindowsAgentInvocation,
  spawnAgentSync,
} from './launch-cli-session.mjs'

describe('DevSpec Cursor CLI flag policy', () => {
  it('infers brainstorm vs work from skill prompts', () => {
    assert.equal(
      inferCursorAgentRunKindFromPrompt(
        'Run the `devspec.brainstorm` skill with this input: abc',
      ),
      'brainstorm',
    )
    assert.equal(
      inferCursorAgentRunKindFromPrompt(
        'Run the `devspec.work` skill with this input: abc',
      ),
      'work',
    )
  })

  it('work interactive flags are YOLO + MCP approve', () => {
    assert.deepEqual(buildInteractiveCursorAgentFlags('work'), [
      '--force',
      '--approve-mcps',
    ])
  })

  it('includes --model when set', () => {
    assert.deepEqual(
      buildInteractiveCursorAgentFlags('work', { model: 'cursor-grok-4.5-high' }),
      ['--force', '--model', 'cursor-grok-4.5-high', '--approve-mcps'],
    )
  })

  it('brainstorm interactive flags are plan + MCP approve (no force)', () => {
    assert.deepEqual(buildInteractiveCursorAgentFlags('brainstorm'), [
      '--plan',
      '--approve-mcps',
    ])
  })
})

describe('quoteWinCmdArg', () => {
  it('leaves safe bare tokens unquoted', () => {
    assert.equal(quoteWinCmdArg('agent'), 'agent')
    assert.equal(quoteWinCmdArg('create-chat'), 'create-chat')
  })

  it('quotes paths that contain spaces', () => {
    const bin = 'C:\\Users\\Brandon Young\\AppData\\Local\\cursor-agent\\agent.cmd'
    assert.equal(quoteWinCmdArg(bin), `"${bin}"`)
  })

  it('doubles embedded quotes inside a quoted token', () => {
    assert.equal(quoteWinCmdArg('say "hi"'), '"say ""hi"""')
  })
})

describe('flattenPromptForArgv', () => {
  it('collapses newlines to spaces', () => {
    assert.equal(
      flattenPromptForArgv('line1\n\nline2\r\nline3'),
      'line1 line2 line3',
    )
  })
})

describe('resolveWindowsAgentInvocation', () => {
  it('maps agent.cmd to sibling agent.ps1 via powershell -File', () => {
    if (process.platform !== 'win32') return
    const cmd = 'C:\\Users\\Brandon Young\\AppData\\Local\\cursor-agent\\agent.cmd'
    const ps1 = 'C:\\Users\\Brandon Young\\AppData\\Local\\cursor-agent\\agent.ps1'
    const inv = resolveWindowsAgentInvocation(cmd, {
      existsSync: (p) => p === ps1,
    })
    assert.equal(inv.mode, 'powershell-ps1')
    assert.match(inv.command.toLowerCase(), /powershell\.exe$/)
    assert.deepEqual(inv.prefixArgs.slice(0, 3), [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
    ])
    assert.equal(inv.prefixArgs[3], '-File')
    assert.equal(inv.prefixArgs[4], ps1)
  })

  it('uses direct mode on non-Windows', () => {
    if (process.platform === 'win32') return
    const inv = resolveWindowsAgentInvocation('/usr/local/bin/agent')
    assert.equal(inv.mode, 'direct')
    assert.equal(inv.command, '/usr/local/bin/agent')
  })
})

describe('resolveShellExecutable', () => {
  it('quotes absolute paths that contain spaces on win32', () => {
    const bin = 'C:\\Users\\Brandon Young\\AppData\\Local\\cursor-agent\\agent.cmd'
    assert.equal(resolveShellExecutable(bin, 'win32'), `"${bin}"`)
  })
})

describe('spawnAgentSync (win32 create-chat)', () => {
  it('runs create-chat via an absolute agent .cmd path from PATH', () => {
    if (process.platform !== 'win32') return

    const located = spawnSync('where.exe', ['agent'], { encoding: 'utf8' })
    const agentBin =
      process.env.DEVSPEC_TEST_AGENT_BIN ||
      String(located.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
    if (!agentBin) return

    const created = spawnAgentSync(agentBin, ['create-chat'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(
      created.status,
      0,
      `agentBin=${agentBin} mode=${resolveWindowsAgentInvocation(agentBin).mode} stderr=${created.stderr} stdout=${created.stdout}`,
    )
    const chatId = String(created.stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1)
    assert.ok(chatId && chatId.length > 8, `expected chat id, got ${JSON.stringify(chatId)}`)
  })
})
