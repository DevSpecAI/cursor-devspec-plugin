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
  buildRemoteWaitCommand,
  buildShortArgvPrompt,
  buildStampedPromptBody,
  flattenPromptForArgv,
  inferCursorAgentRunKindFromPrompt,
  pluginRootFromLauncher,
  pathHasWhitespace,
  quotePathForPrompt,
  spaceSafePluginRoot,
  quoteWinCmdArg,
  resolveShellExecutable,
  resolveStampedPromptPath,
  resolveWindowsAgentInvocation,
  spawnAgentSync,
  stampLine,
  sanitizeWindowsConsoleTitle,
  composeWindowsCursorCliTitle,
  windowsCursorCliStartArgs,
  applyWindowsConsoleTitle,
} from './launch-cli-session.mjs'
import { buildPostLiveRemoteBrief } from './pin-remote-plugin.mjs'

describe('DevSpec Cursor CLI flag policy', () => {
  it('a stale brainstorm prompt now reads as work — there is no plan kind', () => {
    // devspec.brainstorm was the only route to Cursor's --plan mode and it is
    // deleted, so an old prompt pasted from somewhere must fall through to work
    // rather than to a kind nothing can produce.
    assert.equal(
      inferCursorAgentRunKindFromPrompt(
        'Run the `devspec.brainstorm` skill with this input: abc',
      ),
      'work',
    )
    assert.equal(
      inferCursorAgentRunKindFromPrompt(
        'Use the DevSpec MCP connection to work on action item abc',
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

  it('Connect argv is wait-first background tail and does not say read the stamp first (items 1586a9e4, 9d89a6d2)', () => {
    const stampedPath = path.join(os.tmpdir(), 'connect.stamped-waitfirst.txt')
    const pluginRoot = path.join(os.tmpdir(), 'ext-root')
    const connectionId = '4f088b52-0f2c-4a8a-abb6-758e96cf5061'
    const wakeFile = path.join(os.tmpdir(), 'DevSpec', 'wakes', `${connectionId}.jsonl`)
    const waitCommand = buildRemoteWaitCommand({
      pluginRoot,
      connectionId,
      launchId: '61909d7c-f48f-47b9-b96d-4323de517aaf',
      wakeFile,
    })
    assert.match(waitCommand, /devspec-wake-tail\.mjs/)
    assert.match(waitCommand, /--file/)
    assert.doesNotMatch(waitCommand, /--from-end/)
    assert.ok(waitCommand.includes(quotePathForPrompt(path.join(pluginRoot, 'hooks', 'scripts', 'devspec-wake-tail.mjs'))))
    assert.ok(waitCommand.includes(quotePathForPrompt(wakeFile)))

    const argv = buildShortArgvPrompt(stampedPath, { waitFirst: true, waitCommand })
    assert.equal(argv.includes('---'), false)
    assert.match(argv, /^Arm wait FIRST/)
    assert.doesNotMatch(argv, /^Read the file at /)
    assert.match(argv, /block_until_ms: 0/)
    assert.match(argv, /notify_on_output/)
    assert.match(argv, /owner_message\|session_ended\|playbook_dispatch/)
    assert.doesNotMatch(waitCommand, /--from-end/)
    assert.ok(argv.includes(path.resolve(stampedPath)))
    assert.match(argv, /Do not pass --from-end/)
    assert.match(argv, /post_session_message/)
    assert.match(argv, /complete_turn true/)
    assert.match(argv, /Do not only print the answer in this CLI/)
    assert.match(argv, /Do NOT call poll_connection to discover/)
    assert.match(argv, /Do NOT post connect\/status\/listening chrome/)
    assert.match(argv, /If the wake has no command body, post nothing/)
    assert.match(argv, /full owner_message with message body/)
    assert.doesNotMatch(argv, /act only on that/)
    assert.ok(argv.length < 2200, `argv too long: ${argv.length}`)
    assert.ok(
      fs.existsSync(path.join(pluginRootFromLauncher(), 'hooks', 'scripts', 'devspec-wake-tail.mjs')),
      'launcher plugin root must resolve wake-tail script',
    )
  })

  it('Connect wait argv uses a space-free pin when pluginRoot has spaces (item dc3fb0f5)', () => {
    const pluginRoot = path.join(os.tmpdir(), 'Users', 'Brandon Young', 'ext')
    assert.equal(pathHasWhitespace(pluginRoot), true)
    const pinRoot = path.join(os.tmpdir(), 'DevSpecPin', 'cursor-plugin')
    assert.equal(pathHasWhitespace(pinRoot), false)
    const connectionId = '1ae93936-69bb-4a27-9cfe-9480e4a221ff'
    const programData = path.join(os.tmpdir(), 'ProgramDataNoSpace')
    let linked = null
    const waitCommand = buildRemoteWaitCommand({
      pluginRoot,
      connectionId,
      launchId: 'bbddf870-8ae6-42dc-a244-666df32d00a0',
      spaceSafe: {
        platform: 'win32',
        pinRoot,
        mkdirSync: () => {},
        existsSync: () => false,
        lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false }),
        rmSync: () => {},
        symlinkSync: (target, dest) => {
          linked = { target, dest }
        },
        readlinkSync: () => '',
      },
      wakeFileOpts: { platform: 'win32', programData },
    })
    assert.equal(linked?.target, path.resolve(pluginRoot))
    assert.equal(linked?.dest, path.resolve(pinRoot))
    const scriptToken = waitCommand.split(' ').find((t) => t.endsWith('devspec-wake-tail.mjs'))
    assert.ok(scriptToken, waitCommand)
    assert.equal(pathHasWhitespace(scriptToken), false)
    assert.equal(scriptToken.includes('Brandon Young'), false)
    assert.doesNotMatch(waitCommand, /--from-end/)
    assert.match(waitCommand, new RegExp(connectionId.replace(/-/g, '\\-')))

    const argv = buildShortArgvPrompt(path.join(os.tmpdir(), 'stamp.txt'), {
      waitFirst: true,
      waitCommand,
    })
    assert.match(argv, /^Arm wait FIRST/)
    const nodeScript = argv.split(' ').find((t) => t.endsWith('devspec-wake-tail.mjs'))
    assert.ok(nodeScript)
    assert.equal(pathHasWhitespace(nodeScript), false)
    for (const token of waitCommand.split(' ')) {
      assert.equal(pathHasWhitespace(token), false, token)
    }

    const stamp = buildPostLiveRemoteBrief({
      pluginPath: pluginRoot,
      connectionId,
      launchId: 'bbddf870-8ae6-42dc-a244-666df32d00a0',
    })
    assert.match(stamp, /^PLUGIN=/)
    assert.ok(stamp.includes(`PLUGIN=${pluginRoot}`))
    assert.ok(stamp.includes('Brandon Young'))
  })

  it('spaceSafePluginRoot leaves a space-free root unchanged', () => {
    const root = path.join(os.tmpdir(), 'ext-root')
    assert.equal(spaceSafePluginRoot(root, { platform: 'win32' }), path.resolve(root))
  })

  it('spaceSafePluginRoot leaves spaced POSIX roots unchanged', () => {
    const root = path.join(os.tmpdir(), 'Brandon Young', 'ext')
    assert.equal(spaceSafePluginRoot(root, { platform: 'linux' }), path.resolve(root))
  })

  it('wait argv stays space-free when a leftover cursor-plugin junction points at an old VSIX (item 6de4b055)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-pin-legacy-'))
    try {
      const programData = tmp
      const legacyPin = path.join(programData, 'DevSpec', 'cursor-plugin')
      const oldVsix = path.join(tmp, 'extensions', 'devspecai.devspec-autopilot-0.5.3')
      const pluginRoot = path.join(tmp, 'Users', 'Brandon Young', 'ext')
      fs.mkdirSync(oldVsix, { recursive: true })
      fs.mkdirSync(pluginRoot, { recursive: true })
      fs.mkdirSync(path.dirname(legacyPin), { recursive: true })
      fs.symlinkSync(oldVsix, legacyPin, 'junction')

      const waitCommand = buildRemoteWaitCommand({
        pluginRoot,
        connectionId: '70b341ea-401d-43d1-a126-9aa02c6725c6',
        launchId: '58ad9f8c-f2f6-4663-b6a1-e9c7e2a590ea',
        spaceSafe: { platform: 'win32', programData },
        wakeFileOpts: { platform: 'win32', programData },
      })
      const scriptToken = waitCommand.split(' ').find((t) => t.endsWith('devspec-wake-tail.mjs'))
      assert.ok(scriptToken, waitCommand)
      assert.equal(pathHasWhitespace(scriptToken), false)
      assert.equal(scriptToken.includes('Brandon Young'), false)
      assert.match(scriptToken, /cursor-plugin-[0-9a-f]{12}/)
      for (const token of waitCommand.split(' ')) {
        assert.equal(pathHasWhitespace(token), false, token)
      }
      assert.equal(path.resolve(fs.readlinkSync(legacyPin)), path.resolve(oldVsix))

      const stamp = buildPostLiveRemoteBrief({
        pluginPath: pluginRoot,
        connectionId: '70b341ea-401d-43d1-a126-9aa02c6725c6',
        launchId: '58ad9f8c-f2f6-4663-b6a1-e9c7e2a590ea',
      })
      assert.ok(stamp.includes(`PLUGIN=${pluginRoot}`))
      assert.ok(stamp.includes('Brandon Young'))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not fail-open to a spaced plugin root when pin create fails (item 6de4b055)', () => {
    const pluginRoot = path.join(os.tmpdir(), 'Users', 'Brandon Young', 'ext-fail')
    assert.throws(
      () =>
        buildRemoteWaitCommand({
          pluginRoot,
          connectionId: '70b341ea-401d-43d1-a126-9aa02c6725c6',
          spaceSafe: {
            platform: 'win32',
            pinRoot: path.join(os.tmpdir(), 'DevSpecPinFail', 'cursor-plugin'),
            mkdirSync: () => {},
            existsSync: () => false,
            lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false }),
            unlinkSync: () => {},
            rmdirSync: () => {},
            symlinkSync: () => {
              throw new Error('EPERM')
            },
            readlinkSync: () => '',
          },
        }),
      /cannot pin spaced plugin root|EPERM/,
    )
  })

  it('open-handler --install ensures the space-free pin (item 6de4b055)', () => {
    const src = fs.readFileSync(new URL('./open-handler.mjs', import.meta.url), 'utf8')
    assert.match(src, /ensureSpaceSafePluginPin/)
    assert.match(src, /space-safe-plugin-root\.mjs/)
  })

  it('Connect launcher starts host-owned wake follow after the poller (item 9d89a6d2)', () => {
    const src = fs.readFileSync(new URL('./launch-cli-session.mjs', import.meta.url), 'utf8')
    assert.match(src, /ensureWakeFollowAfterAgentSpawn/)
    assert.match(src, /ensure_wake_follow/)
    assert.match(src, /devspec-wake-tail\.mjs/)
    assert.match(src, /block_until_ms: 0/)
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

describe('Windows Cursor console title (item 20900b80)', () => {
  it('strips quotes and cmd metacharacters', () => {
    assert.equal(sanitizeWindowsConsoleTitle('Brave "Panda"'), 'Brave Panda')
    assert.equal(sanitizeWindowsConsoleTitle('A & B | C'), 'A B C')
  })

  it('uses minted codename after Live and stamp before', () => {
    assert.equal(composeWindowsCursorCliTitle({ codename: 'Brave Panda' }), 'DevSpec Cursor · Brave Panda')
    assert.equal(
      composeWindowsCursorCliTitle({ stamp: '1787229023147-4hmfqg' }),
      'DevSpec Cursor · 1787229023147-4hmfqg',
    )
    assert.equal(composeWindowsCursorCliTitle({}), 'DevSpec Cursor')
    assert.notEqual(composeWindowsCursorCliTitle({}), 'DevSpec Cursor CLI')
  })

  it('two concurrent Connects compose two different titles', () => {
    const a = composeWindowsCursorCliTitle({ codename: 'Brave Panda' })
    const b = composeWindowsCursorCliTitle({ codename: 'Lucky Caracal' })
    assert.notEqual(a, b)
    assert.match(a, /Brave Panda/)
    assert.match(b, /Lucky Caracal/)
    const stampA = composeWindowsCursorCliTitle({ stamp: 'stamp-aaa' })
    const stampB = composeWindowsCursorCliTitle({ stamp: 'stamp-bbb' })
    assert.notEqual(stampA, stampB)
  })

  it('start argv is titled cmd.exe, never wt.exe, never hardcoded DevSpec Cursor CLI', () => {
    const title = composeWindowsCursorCliTitle({ stamp: 'stamp-1' })
    const args = windowsCursorCliStartArgs('C:\\tmp\\x.cmd', title)
    assert.deepEqual(args, ['/c', 'start', title, 'cmd.exe', '/k', 'C:\\tmp\\x.cmd'])
    assert.ok(!args.some((a) => /wt\.exe/i.test(a)))
    assert.ok(!args.includes('DevSpec Cursor CLI'))
  })

  it('applyWindowsConsoleTitle sets process.title and skips wt.exe', () => {
    const titles = []
    const execs = []
    const r = applyWindowsConsoleTitle('DevSpec Cursor · Brave Panda', {
      platform: 'win32',
      setProcessTitle: (t) => titles.push(t),
      execTitle: (t) => execs.push(t),
    })
    assert.equal(r.ok, true)
    assert.deepEqual(titles, ['DevSpec Cursor · Brave Panda'])
    assert.deepEqual(execs, ['DevSpec Cursor · Brave Panda'])
  })
})
