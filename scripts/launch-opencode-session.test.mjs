import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  basicAuthHeaderValue,
  buildOpencodeRunArgs,
  extractSessionIdFromPrompt,
  redactArgsForLog,
  resolveServeAuth,
  withServeAuthEnv,
} from './launch-opencode-session.mjs'

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

describe('resolveServeAuth', () => {
  it('reuses a non-empty OPENCODE_SERVER_PASSWORD from env', () => {
    const auth = resolveServeAuth({
      OPENCODE_SERVER_PASSWORD: ' already-set ',
      OPENCODE_SERVER_USERNAME: 'custom',
    })
    assert.equal(auth.source, 'env')
    assert.equal(auth.password, 'already-set')
    assert.equal(auth.username, 'custom')
  })

  it('mints a strong password when env password is missing', () => {
    const auth = resolveServeAuth({})
    assert.equal(auth.source, 'minted')
    assert.equal(auth.username, 'opencode')
    assert.ok(auth.password.length >= 32)
  })

  it('mints when env password is whitespace-only', () => {
    const auth = resolveServeAuth({ OPENCODE_SERVER_PASSWORD: '   ' })
    assert.equal(auth.source, 'minted')
  })
})

describe('withServeAuthEnv + basicAuthHeaderValue + redactArgsForLog', () => {
  it('copies auth into child env without mutating the parent', () => {
    const parent = { PATH: '/bin', OPENCODE_PERMISSION: '{}' }
    const next = withServeAuthEnv(parent, { username: 'opencode', password: 'secret' })
    assert.equal(next.OPENCODE_SERVER_PASSWORD, 'secret')
    assert.equal(next.OPENCODE_SERVER_USERNAME, 'opencode')
    assert.equal(parent.OPENCODE_SERVER_PASSWORD, undefined)
  })

  it('builds a Basic auth header', () => {
    assert.equal(
      basicAuthHeaderValue('opencode', 'secret'),
      `Basic ${Buffer.from('opencode:secret', 'utf8').toString('base64')}`,
    )
  })

  it('redacts --password values in argv logs', () => {
    assert.deepEqual(redactArgsForLog(['run', '--password', 's3cret', '--attach', 'http://x']), [
      'run',
      '--password',
      '<redacted>',
      '--attach',
      'http://x',
    ])
  })
})
