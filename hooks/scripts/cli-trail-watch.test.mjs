import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'
import {
  ensureCliTrailWatch,
  isWatchPidAlive,
  readTurnMarker as readWatcherTurnMarker,
  shouldStreamTurnTrail,
  trailWatchPidPath,
} from './cli-trail-watch.mjs'
import { readTrailState, resolveAgentTranscriptPath, serializeTranscriptJsonl } from './work-trail.mjs'
import { postTrailFromTranscript } from './post-trail-from-transcript.mjs'
import { runTrailTurn } from './trail-turn.mjs'
import { readActiveTurnMarker, writeTurnMarker } from './mirror-turn.mjs'
import { deliverAutomationDispatches } from './devspec-remote-poll.mjs'

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

  it('retries cleanly when a pre-claim transcript trail post throws before claim_automation_run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-sessionless-tx-'))
    try {
      const connectionId = '11111111-2222-4333-8444-777777777777'
      const transcriptPath = path.join(dir, 'agent.jsonl')
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          role: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Shell', input: { command: 'git status' } }],
          },
        }) + '\n',
      )

      let shouldFail = true
      const posts = []
      const call = async (req) => {
        if (shouldFail) throw new Error('session_id is required when no running automation run')
        posts.push(req)
        return { ok: true }
      }

      await assert.rejects(() =>
        postTrailFromTranscript({
          connectionId,
          mcpUrl: 'https://example.test/mcp',
          token: 'dvs_test',
          transcriptPath,
          connectionsDir: dir,
          call,
          now: 10_000,
        }),
      )
      assert.equal(readTrailState(connectionId, dir), null)

      shouldFail = false
      const ok = await postTrailFromTranscript({
        connectionId,
        mcpUrl: 'https://example.test/mcp',
        token: 'dvs_test',
        transcriptPath,
        connectionsDir: dir,
        call,
        now: 10_200,
      })
      assert.equal(ok.ok, true)
      assert.equal(posts.length, 1)
      assert.equal(posts[0].arguments.phase, 'trail')
      assert.match(posts[0].arguments.message, /\$ Shell/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sessionless automation trail streaming across poller, mirror-turn, trail-turn, and cli-trail-watch', () => {
  it('deliverAutomationDispatches marks remoteTurn, starts cli watcher without sessionId, and skips Working seed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-auto-dispatch-'))
    try {
      const connectionId = '22222222-3333-4444-8555-888888888888'
      let seeded = false
      let watchWatched = null
      const res = await deliverAutomationDispatches(
        connectionId,
        [{ run_id: 'run-1', dispatch_id: 'disp-1', instruction: 'Check repos' }],
        'cursor-1',
        null,
        {
          dir,
          emit: () => {},
          appendInboxFn: () => ({ ok: true, duplicate: false }),
          readStateFn: () => ({ token: 'dvs_test', mcp_url: 'https://example.test/mcp' }),
          seedFn: async () => {
            seeded = true
          },
          ensureWatch: (arg) => {
            watchWatched = arg
            return { started: true, pid: 12345 }
          },
        },
      )
      assert.equal(res.ok, true)
      assert.equal(res.acceptedCount, 1)
      assert.equal(seeded, false, 'sessionless automation must not seed Working… placeholder')
      assert.equal(watchWatched?.connectionId, connectionId)

      const marker = readWatcherTurnMarker(connectionId, dir)
      assert.equal(marker?.remoteTurn, true)
      assert.equal(shouldStreamTurnTrail({ enabled: true, session_id: null }, marker), true)
      assert.equal(shouldStreamTurnTrail({ enabled: true, session_id: null }, { startedAt: Date.now() }), false)

      // Subsequent user_prompt writeTurnMarker while turn is live preserves remoteTurn: true
      writeTurnMarker(connectionId, { dir })
      const preserved = readActiveTurnMarker(connectionId, { dir })
      assert.equal(preserved?.remoteTurn, true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runTrailTurn streams sessionless remote turns, suppresses seed and unattached local turns, and retries after pre-claim refusal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-trail-turn-'))
    try {
      const connectionId = '33333333-4444-4555-8666-999999999999'
      const sessionlessState = {
        enabled: true,
        connection_id: connectionId,
        session_id: null,
        token: 'dvs_test',
        mcp_url: 'https://example.test/mcp',
      }
      const posts = []
      let refusePreClaim = false
      const call = async (req) => {
        if (refusePreClaim) throw new Error('pre-claim refusal')
        posts.push(req)
        return { ok: true }
      }

      // 1. Seed mode on sessionless connection is suppressed
      writeTurnMarker(connectionId, { remoteTurn: true, dir })
      const seedRes = await runTrailTurn({
        modeArg: 'seed',
        raw: '{}',
        connectionsDir: dir,
        loadStateFn: () => sessionlessState,
        call,
        now: 20_000,
      })
      assert.equal(seedRes.skipped, true)
      assert.equal(seedRes.reason, 'seed_requires_session')
      assert.equal(posts.length, 0)

      // 2. Pre-claim refusal does not latch lastPostedHash, so next tool step retries & streams
      refusePreClaim = true
      const preClaimRes = await runTrailTurn({
        modeArg: 'postToolUse',
        raw: JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'git fetch' } }),
        connectionsDir: dir,
        loadStateFn: () => sessionlessState,
        call,
        now: 21_000,
      })
      assert.equal(preClaimRes.reason, 'post_error')
      assert.equal(posts.length, 0)
      assert.equal(readTrailState(connectionId, dir)?.lastPostedHash, null)

      refusePreClaim = false
      const claimedRes = await runTrailTurn({
        modeArg: 'postToolUse',
        raw: JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'git status' } }),
        connectionsDir: dir,
        loadStateFn: () => sessionlessState,
        call,
        now: 22_500,
      })
      assert.equal(claimedRes.ok, true)
      assert.equal(posts.length, 1)
      assert.equal(posts[0].arguments.connection_id, connectionId)
      assert.equal(posts[0].arguments.phase, 'trail')
      assert.match(posts[0].arguments.message, /git fetch/)
      assert.match(posts[0].arguments.message, /git status/)

      // 3. Unattached local editor turn (remoteTurn: false, session_id: null) is suppressed
      fs.rmSync(path.join(dir, `${connectionId}.turn`), { force: true })
      writeTurnMarker(connectionId, { remoteTurn: false, dir })
      posts.length = 0
      const localRes = await runTrailTurn({
        modeArg: 'postToolUse',
        raw: JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'ls -la' } }),
        connectionsDir: dir,
        loadStateFn: () => sessionlessState,
        call,
        now: 25_000,
      })
      assert.equal(localRes.skipped, true)
      assert.equal(localRes.reason, 'unattached_local_turn')
      assert.equal(posts.length, 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
