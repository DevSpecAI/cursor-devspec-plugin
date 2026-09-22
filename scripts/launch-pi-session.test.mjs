import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildPiLaunchArgs,
  buildWindowsVisiblePiStartArgs,
  parsePiLaunchArgs,
  PI_THINKING_LEVELS,
} from './launch-pi-session.mjs'

describe('buildPiLaunchArgs', () => {
  it('keeps the default launch free of frozen runtime overrides', () => {
    assert.deepEqual(buildPiLaunchArgs('Use devspec.remote for session abc'), [
      'Use devspec.remote for session abc',
    ])
  })

  it('applies an explicitly selected host model and thinking level', () => {
    assert.deepEqual(
      buildPiLaunchArgs('Connect now', {
        model: 'anthropic/claude-sonnet-5',
        thinking: 'high',
      }),
      ['--model', 'anthropic/claude-sonnet-5', '--thinking', 'high', 'Connect now'],
    )
  })

  it('rejects unknown thinking values rather than forwarding arbitrary flags', () => {
    assert.deepEqual(buildPiLaunchArgs('Connect now', { thinking: 'turbo' }), ['Connect now'])
    assert.deepEqual(PI_THINKING_LEVELS, [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })
})

describe('parsePiLaunchArgs', () => {
  it('reads launcher-owned arguments without interpreting the prompt', () => {
    assert.deepEqual(
      parsePiLaunchArgs([
        '--folder',
        '/repo',
        '--prompt-file',
        '/tmp/prompt',
        '--pi',
        '/usr/local/bin/pi',
        '--model',
        'openai-codex/gpt-5.4',
        '--thinking',
        'xhigh',
      ]),
      {
        folder: '/repo',
        promptFile: '/tmp/prompt',
        pi: '/usr/local/bin/pi',
        model: 'openai-codex/gpt-5.4',
        thinking: 'xhigh',
      },
    )
  })
})

describe('buildWindowsVisiblePiStartArgs', () => {
  it('opens a titled cmd /k window (not a hidden Pi process)', () => {
    assert.deepEqual(buildWindowsVisiblePiStartArgs('C:\\Tools\\pi.cmd', ['hello world']), [
      '/c',
      'start',
      'DevSpec Pi',
      'cmd.exe',
      '/k',
      'C:\\Tools\\pi.cmd "hello world"',
    ])
  })
})
