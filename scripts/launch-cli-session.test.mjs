#!/usr/bin/env node
/**
 * Unit tests for Windows CLI agent spawn quoting.
 * Run: node --test scripts/launch-cli-session.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  quoteWinCmdArg,
  resolveShellExecutable,
  spawnAgentSync,
} from './launch-cli-session.mjs'

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

  it('quotes an empty string as empty quotes', () => {
    assert.equal(quoteWinCmdArg(''), '""')
  })
})

describe('resolveShellExecutable', () => {
  it('quotes absolute paths that contain spaces on win32', () => {
    const bin = 'C:\\Users\\Brandon Young\\AppData\\Local\\cursor-agent\\agent.cmd'
    assert.equal(resolveShellExecutable(bin, 'win32'), `"${bin}"`)
  })

  it('does not quote paths with spaces on non-Windows platforms', () => {
    const bin = '/Users/Brandon Young/.local/bin/agent'
    assert.equal(resolveShellExecutable(bin, 'darwin'), bin)
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
    if (!agentBin) {
      // Cursor CLI not installed — pure quoting tests above still cover the bug.
      return
    }

    const created = spawnAgentSync(agentBin, ['create-chat'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(
      created.status,
      0,
      `agentBin=${agentBin} stderr=${created.stderr} stdout=${created.stdout}`,
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
