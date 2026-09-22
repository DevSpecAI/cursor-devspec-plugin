import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import os from 'node:os'
import {
  buildWindowsCliLaunchBat,
  buildWindowsCliStartCommand,
  resolveCliLauncher,
  resolveAppBaseUrl,
  runNodeLaunchSettled,
  OPENCODE_LAUNCH_HEADED,
  DEVSPEC_DIR,
} from './open-handler-core.mjs'

describe('buildWindowsCliLaunchBat', () => {
  it('uses cmd-style quoting and never bash-style backslash escapes', () => {
    const bat = buildWindowsCliLaunchBat(
      'C:\\nvm4w\\nodejs\\node.exe',
      [
        'C:\\Users\\Brandon Young\\.cursor\\devspec\\launch-cli-session.mjs',
        '--folder',
        'C:\\Users\\Brandon Young\\Repositories\\Combined\\DevSpecV2',
        '--agent',
        'C:\\Users\\Brandon Young\\AppData\\Local\\cursor-agent\\agent.cmd',
      ],
      'C:\\Users\\Brandon Young\\Repositories\\Combined\\DevSpecV2',
    )

    assert.match(bat, /^@echo off\r\n/)
    assert.doesNotMatch(bat, /\\"/)
    assert.match(bat, /cd \/d "C:\\Users\\Brandon Young\\Repositories\\Combined\\DevSpecV2"/)
    assert.match(
      bat,
      /"C:\\Users\\Brandon Young\\.cursor\\devspec\\launch-cli-session\.mjs"/,
    )
    assert.match(bat, /C:\\nvm4w\\nodejs\\node\.exe/)
  })
})

describe('buildWindowsCliStartCommand', () => {
  it('uses cmd-style quoting and never bash-style backslash escapes', () => {
    const cmd = buildWindowsCliStartCommand('C:\\nvm4w\\nodejs\\node.exe', [
      'C:\\Users\\Brandon Young\\.cursor\\devspec\\launch-cli-session.mjs',
      '--folder',
      'C:\\Users\\Brandon Young\\Repositories\\Combined\\DevSpecV2',
      '--agent',
      'C:\\Users\\Brandon Young\\AppData\\Local\\cursor-agent\\agent.cmd',
    ])

    assert.match(cmd, /^start "DevSpec Cursor" cmd\.exe \/k /)
    assert.doesNotMatch(cmd, /DevSpec Cursor CLI/)
    assert.doesNotMatch(cmd, /wt\.exe/)
    assert.doesNotMatch(cmd, /\\"/)
  })

  it('strips quotes from the window title', () => {
    const cmd = buildWindowsCliStartCommand('node', ['script.mjs'], 'Title "x"')
    assert.match(cmd, /^start "Title x" cmd\.exe \/k /)
  })

  it('start title with a launch stamp is unique and not DevSpec Cursor CLI', () => {
    const a = buildWindowsCliStartCommand('node', ['a.mjs'], 'DevSpec Cursor · stamp-a')
    const b = buildWindowsCliStartCommand('node', ['b.mjs'], 'DevSpec Cursor · stamp-b')
    assert.match(a, /^start "DevSpec Cursor · stamp-a"/)
    assert.match(b, /^start "DevSpec Cursor · stamp-b"/)
    assert.notEqual(a, b)
    assert.doesNotMatch(a, /DevSpec Cursor CLI/)
  })
})

describe('resolveCliLauncher', () => {
  const moduleDir = path.join(os.homedir(), 'fake-module-dir')
  const extensionRoot = path.join(os.homedir(), 'fake-extension')
  const scriptName = 'launch-cli-session.mjs'
  const extensionLauncher = path.join(extensionRoot, 'scripts', scriptName)
  const installedLauncher = path.join(DEVSPEC_DIR, scriptName)
  const siblingLauncher = path.join(moduleDir, scriptName)

  it('prefers the extension launcher when the marker root exists', () => {
    const present = new Set([extensionLauncher, installedLauncher, siblingLauncher])
    const resolved = resolveCliLauncher(scriptName, {
      moduleDir,
      extensionRoot,
      existsSync: (p) => present.has(p),
    })
    assert.equal(resolved.source, 'extension')
    assert.equal(resolved.path, extensionLauncher)
  })

  it('falls back to installed when extension root is missing on disk', () => {
    const present = new Set([installedLauncher, siblingLauncher])
    const resolved = resolveCliLauncher(scriptName, {
      moduleDir,
      extensionRoot,
      existsSync: (p) => present.has(p),
    })
    assert.equal(resolved.source, 'installed')
    assert.equal(resolved.path, installedLauncher)
  })

  it('falls back to sibling when neither extension nor installed exists', () => {
    const present = new Set([siblingLauncher])
    const resolved = resolveCliLauncher(scriptName, {
      moduleDir,
      extensionRoot: null,
      existsSync: (p) => present.has(p),
    })
    assert.equal(resolved.source, 'sibling')
    assert.equal(resolved.path, siblingLauncher)
  })

  it('does not prefer a stale installed copy over a present extension', () => {
    // Installed exists and is "older" in spirit; extension still wins.
    const present = new Set([extensionLauncher, installedLauncher])
    const resolved = resolveCliLauncher(scriptName, {
      moduleDir,
      extensionRoot,
      existsSync: (p) => present.has(p),
    })
    assert.equal(resolved.source, 'extension')
    assert.notEqual(resolved.path, installedLauncher)
  })
})

describe('fleet settle ready-gate', () => {
  it('defaults OpenCode production launches to headed', () => {
    assert.equal(OPENCODE_LAUNCH_HEADED, true)
  })

  it('runNodeLaunchSettled resolves ok when the child exits 0', async () => {
    const result = await runNodeLaunchSettled({
      nodeBin: process.execPath,
      launchArgs: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      label: 'test-settle-ok',
      timeoutMs: 10_000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.code, 0)
  })

  it('runNodeLaunchSettled resolves failed when the child exits non-zero', async () => {
    const result = await runNodeLaunchSettled({
      nodeBin: process.execPath,
      launchArgs: ['-e', 'process.exit(7)'],
      cwd: process.cwd(),
      label: 'test-settle-fail',
      timeoutMs: 10_000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'settle_failed')
    assert.equal(result.code, 7)
  })
})

describe('resolveAppBaseUrl', () => {
  it('prefers DEVSPEC_APP_URL when set', () => {
    const base = resolveAppBaseUrl({
      env: { DEVSPEC_APP_URL: 'https://app.devspecstaging.com/' },
      readFileSync: () => {
        throw new Error('should not read remote-control when env is set')
      },
    })
    assert.equal(base, 'https://app.devspecstaging.com')
  })

  it('mirrors staging MCP host when env is unset', () => {
    const base = resolveAppBaseUrl({
      env: {},
      remoteControlPath: '/tmp/fake-rc.json',
      readFileSync: () =>
        JSON.stringify({ mcp_url: 'https://api.devspecstaging.com/api/mcp' }),
    })
    assert.equal(base, 'https://app.devspecstaging.com')
  })

  it('mirrors production MCP host when env is unset', () => {
    const base = resolveAppBaseUrl({
      env: {},
      remoteControlPath: '/tmp/fake-rc.json',
      readFileSync: () => JSON.stringify({ mcp_url: 'https://api.devspec.ai/api/mcp' }),
    })
    assert.equal(base, 'https://app.devspec.ai')
  })

  it('falls back to production app host when nothing is configured', () => {
    const base = resolveAppBaseUrl({
      env: {},
      remoteControlPath: '/tmp/missing-rc.json',
      readFileSync: () => {
        throw new Error('ENOENT')
      },
    })
    assert.equal(base, 'https://app.devspec.ai')
  })
})
