#!/usr/bin/env node
/**
 * Unit tests for Windows CLI agent spawn quoting / invocation.
 * Run: node --test scripts/launch-cli-session.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildInteractiveCursorAgentFlags,
  buildShortArgvPrompt,
  buildStampedPromptBody,
  flattenPromptForArgv,
  inferCursorAgentRunKindFromPrompt,
  quoteWinCmdArg,
  resolveShellExecutable,
  resolveStampedPromptPath,
  resolveWindowsAgentInvocation,
  spawnAgentSync,
  stampLine,
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

describe('stamped prompt file / short argv (item e949305f)', () => {
  it('buildStampedPromptBody keeps multiline skill body + stamp off argv shape', () => {
    const body = [
      'PLUGIN=C:\\Users\\Brandon Young\\.cursor\\extensions\\x',
      '',
      '# DevSpec Remote Control — already Live',
      '',
      'connection_id: aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'Arm wait with --from-end then --pending --after-reply.',
    ].join('\n')
    const stamped = buildStampedPromptBody(body, 'b49da2cc-8477-4d62-9f66-727f19f41226')
    assert.match(stamped, /^PLUGIN=/)
    assert.ok(stamped.includes('already Live'))
    assert.ok(stamped.includes(stampLine('b49da2cc-8477-4d62-9f66-727f19f41226')))
    // Must remain multiline — flattening this onto argv is what caused --- to leak.
    assert.ok(stamped.includes('\n'))
  })

  it('buildStampedPromptBody can stamp launch_id for Axiom phase join (item 383de0cd)', () => {
    const stamped = buildStampedPromptBody('hi', 'chat-1', { launchId: 'launch-uuid-1' })
    assert.ok(stamped.includes(stampLine('chat-1')))
    assert.ok(stamped.includes('DevSpec launch_id for this run'))
    assert.ok(stamped.includes('launch-uuid-1'))
  })

  it('resolveStampedPromptPath colocates beside the launch prompt file', () => {
    const promptFile = path.join(
      os.homedir(),
      '.cursor',
      'devspec',
      'launches',
      '1785768860576-hwny5h.prompt.txt',
    )
    const stamped = resolveStampedPromptPath(
      promptFile,
      'b49da2cc-8477-4d62-9f66-727f19f41226',
    )
    assert.equal(
      stamped,
      path.join(
        path.dirname(promptFile),
        '1785768860576-hwny5h.stamped-b49da2cc8477.txt',
      ),
    )
  })

  it('buildShortArgvPrompt stays short and never contains YAML --- tokens', () => {
    const stampedPath = path.join(
      os.tmpdir(),
      '1785768860576-hwny5h.stamped-b49da2cc8477.txt',
    )
    const argv = buildShortArgvPrompt(stampedPath)
    assert.ok(argv.length < 500, `argv too long: ${argv.length}`)
    assert.equal(argv.includes('---'), false)
    assert.ok(argv.includes(path.resolve(stampedPath)))
    assert.match(argv, /Read the file at /)
  })

  it('short argv would not present --- as its own agent CLI option token', () => {
    // Reconstruct the argv array launch-cli-session passes to agent.
    const stampedPath = path.join(os.tmpdir(), 'launch.stamped-test.txt')
    fs.writeFileSync(
      stampedPath,
      buildStampedPromptBody(
        '---\nname: devspec.remote\n---\n\n# Body with --- tables\n|---|---|',
        'chat-1',
      ),
      'utf8',
    )
    try {
      const argvPrompt = buildShortArgvPrompt(stampedPath)
      const agentArgv = [
        '--resume',
        'chat-1',
        '--workspace',
        'C:\\repo',
        '--force',
        '--approve-mcps',
        argvPrompt,
      ]
      // Every standalone argv token that looks like an option must be a known flag.
      const known = new Set([
        '--resume',
        '--workspace',
        '--force',
        '--approve-mcps',
        '--plan',
        '--model',
        '--approve-mcps',
      ])
      for (const token of agentArgv) {
        if (token === '---' || /^---/.test(token)) {
          assert.fail(`bare --- leaked onto argv: ${JSON.stringify(agentArgv)}`)
        }
        if (token.startsWith('--') && !known.has(token) && !token.startsWith('--workspace')) {
          // Values after flags are fine; only reject unknown option-shaped tokens
          // that are not flag values (chat id, path, prompt).
          if (token === '--resume' || token === '--force' || token === '--approve-mcps') continue
        }
      }
      assert.equal(agentArgv.includes('---'), false)
      assert.ok(!agentArgv.some((t) => t === '---'))
      // The prompt arg is one element and contains no --- substring.
      assert.equal(argvPrompt.includes('---'), false)
    } finally {
      fs.unlinkSync(stampedPath)
    }
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

  it('spawns a real .exe directly on Windows, no cmd.exe wrapping', () => {
    if (process.platform !== 'win32') return
    // Real bug: OpenCode ships a compiled .exe, not an npm .cmd/.ps1 shim
    // trio — routing it through the cmd.exe fallback added an unhideable
    // console window. A bare .exe needs no shell at all.
    const exe = 'C:\\Users\\Brandon Young\\.opencode\\bin\\opencode.exe'
    const inv = resolveWindowsAgentInvocation(exe, { existsSync: () => false })
    assert.equal(inv.mode, 'direct')
    assert.equal(inv.command, exe)
    assert.deepEqual(inv.prefixArgs, [])
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
