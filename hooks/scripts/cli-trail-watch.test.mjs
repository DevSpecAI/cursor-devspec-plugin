import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'
import {
  ensureCliTrailWatch,
  isWatchPidAlive,
  trailWatchPidPath,
} from './cli-trail-watch.mjs'
import { resolveAgentTranscriptPath, serializeTranscriptJsonl } from './work-trail.mjs'
import { postTrailFromTranscript } from './post-trail-from-transcript.mjs'

describe('resolveAgentTranscriptPath', () => {
  let home
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-home-'))
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const dir = path.join(home, '.cursor', 'projects', 'proj-a', 'agent-transcripts', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"role":"user"}\n')
  })
  after(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('finds transcript under ~/.cursor/projects', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const found = resolveAgentTranscriptPath(id, { home })
    assert.ok(found)
    assert.match(found, new RegExp(`${id}\\.jsonl$`))
  })

  it('rejects path traversal ids', () => {
    assert.equal(resolveAgentTranscriptPath('../evil', { home }), null)
  })
})

describe('serializeTranscriptJsonl skips DevSpec posts', () => {
  it('omits CallMcpTool post_session_message', () => {
    const jsonl = [
      JSON.stringify({
        role: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Shell', input: { command: 'pwd' } },
            {
              type: 'tool_use',
              name: 'CallMcpTool',
              input: { server: 'devspec', toolName: 'post_session_message', arguments: { message: 'hi' } },
            },
          ],
        },
      }),
    ].join('\n')
    const out = serializeTranscriptJsonl(jsonl)
    assert.match(out, /\$ Shell/)
    assert.doesNotMatch(out, /post_session_message/)
  })
})

describe('ensureCliTrailWatch', () => {
  it('is idempotent when pid is alive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-watch-'))
    const connectionId = '11111111-2222-3333-4444-555555555555'
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(trailWatchPidPath(connectionId, dir), String(process.pid))
    const r = ensureCliTrailWatch({
      connectionId,
      dir,
      spawnFn: () => {
        throw new Error('should not spawn')
      },
    })
    assert.equal(r.skipped, true)
    assert.equal(r.reason, 'already_running')
    assert.equal(isWatchPidAlive(process.pid), true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('spawns when no live pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-watch-'))
    const connectionId = '11111111-2222-3333-4444-666666666666'
    let spawned = null
    const r = ensureCliTrailWatch({
      connectionId,
      dir,
      scriptPath: path.join(dir, 'noop.mjs'),
      spawnFn: (cmd, args, opts) => {
        spawned = { cmd, args, opts }
        return { pid: 424242, unref() {} }
      },
    })
    assert.equal(r.started, true)
    assert.equal(r.pid, 424242)
    assert.ok(spawned)
    assert.equal(spawned.args[1], '--connection-id')
    assert.equal(spawned.args[2], connectionId)
    assert.equal(fs.readFileSync(trailWatchPidPath(connectionId, dir), 'utf8'), '424242')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('postTrailFromTranscript', () => {
  it('skips when transcript missing', async () => {
    const r = await postTrailFromTranscript({
      connectionId: '00000000-0000-0000-0000-000000000001',
      mcpUrl: 'https://example.test/mcp',
      token: 'dvs_test',
      localId: 'no-such-conversation-id-zzzz',
    })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no_transcript')
  })
})
