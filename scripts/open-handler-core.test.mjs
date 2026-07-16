import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildWindowsCliLaunchBat,
  buildWindowsCliStartCommand,
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

    assert.match(cmd, /^start "DevSpec Cursor CLI" cmd\.exe \/k /)
    assert.doesNotMatch(cmd, /\\"/)
  })

  it('strips quotes from the window title', () => {
    const cmd = buildWindowsCliStartCommand('node', ['script.mjs'], 'Title "x"')
    assert.match(cmd, /^start "Title x" cmd\.exe \/k /)
  })
})
