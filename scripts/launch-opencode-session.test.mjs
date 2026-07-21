import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOpencodeRunArgs, extractSessionIdFromPrompt } from './launch-opencode-session.mjs'

describe('buildOpencodeRunArgs', () => {
  it('routes a leading slash-command through --command, not the plain message', () => {
    const args = buildOpencodeRunArgs('/devspec.remote --session abc-123')
    assert.deepEqual(args, ['run', '--command', 'devspec.remote', '--', '--session abc-123'])
  })

  it('omits the -- separator when the command has no arguments', () => {
    const args = buildOpencodeRunArgs('/devspec.remote-stop')
    assert.deepEqual(args, ['run', '--command', 'devspec.remote-stop'])
  })

  it('passes a plain (non-command) prompt through as the positional message', () => {
    const args = buildOpencodeRunArgs('Say hello and tell me which model you are.')
    assert.deepEqual(args, ['run', 'Say hello and tell me which model you are.'])
  })

  it('includes --model before the command/message when set', () => {
    const args = buildOpencodeRunArgs('/devspec.remote --session abc-123', 'minimax/MiniMax-M3')
    assert.deepEqual(args, [
      'run',
      '--model',
      'minimax/MiniMax-M3',
      '--command',
      'devspec.remote',
      '--',
      '--session abc-123',
    ])
  })
})

describe('extractSessionIdFromPrompt', () => {
  it('reads --session <uuid>', () => {
    const id = extractSessionIdFromPrompt(
      '/devspec.remote --session 7e3afc79-abf4-48e4-ae33-aed27b00944d',
    )
    assert.equal(id, '7e3afc79-abf4-48e4-ae33-aed27b00944d')
  })

  it('returns null when no uuid is present', () => {
    assert.equal(extractSessionIdFromPrompt('/devspec.remote'), null)
  })
})
