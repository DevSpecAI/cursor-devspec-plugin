/**
 * This plugin answers as ITSELF, never as whoever launched it (item 75f65461).
 *
 * One agent launching another is routine now, and the child inherits the whole
 * parent environment. A resolver that probes every host's variable therefore
 * adopts the parent's conversation and starts acting on the parent's
 * connection. These tests pin the two halves of the fix: the id we read, and
 * the bond we match it against.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'

import {
  AGENT_NAME,
  CONVERSATION_ID_ENV_VARS,
  LOCAL_ID_OVERRIDE_ENV_VAR,
} from './agent-identity.mjs'
import { detectLocalId } from './remote-control-state.mjs'
import { selectBoundState } from './mirror-turn.mjs'

/** Every other host's conversation-id variable. None of these are ours. */
const FOREIGN_ENV_VARS = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_THREAD_ID',
  'GROK_SESSION_ID',
  'GROK_CONVERSATION_ID',
  'PI_SESSION_ID',
  'OPENCODE_SESSION',
  // The neutral name is foreign too: a parent exports it and EVERY child
  // inherits it, which is the same defect without a host's name on it.
  'DEVSPEC_REMOTE_LOCAL_ID',
]

const UUID = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'

describe('conversation id is read from this host only', () => {
  it('declares its own variables and none belonging to another host', () => {
    for (const name of CONVERSATION_ID_ENV_VARS) {
      assert.equal(
        FOREIGN_ENV_VARS.includes(name),
        false,
        `${name} belongs to another host — reading it makes this plugin answer as that conversation`,
      )
    }
    assert.ok(CONVERSATION_ID_ENV_VARS.length > 0, 'this host must name at least one variable')
    assert.ok(
      LOCAL_ID_OVERRIDE_ENV_VAR.endsWith('_CURSOR'),
      'the override must be host-qualified, or a spawned child inherits it',
    )
  })

  it('ignores every foreign variable, even when ours is absent', () => {
    for (const name of FOREIGN_ENV_VARS) {
      const got = detectLocalId({}, { [name]: OTHER })
      assert.equal(
        got.local_id,
        null,
        `${name} was adopted as our conversation id — it is not ours to answer as`,
      )
    }
  })

  it('reads our own variable, and prefers an explicit argument over it', () => {
    for (const name of CONVERSATION_ID_ENV_VARS) {
      assert.equal(detectLocalId({}, { [name]: UUID }).local_id, UUID, name)
    }
    assert.equal(detectLocalId({}, { [LOCAL_ID_OVERRIDE_ENV_VAR]: UUID }).local_id, UUID)
    assert.equal(
      detectLocalId({ 'local-id': UUID }, { [CONVERSATION_ID_ENV_VARS[0]]: OTHER }).local_id,
      UUID,
      'an explicit --local-id must win over the environment',
    )
  })

  it('prefers OUR variable when a parent agent has also exported theirs', () => {
    // The launched-by-another-agent case, which is the whole point.
    const env = { CLAUDE_CODE_SESSION_ID: OTHER, GROK_SESSION_ID: OTHER }
    env[CONVERSATION_ID_ENV_VARS[0]] = UUID
    assert.equal(detectLocalId({}, env).local_id, UUID)
  })

  it('names the source it used, so a wrong answer is traceable', () => {
    const got = detectLocalId({}, { [CONVERSATION_ID_ENV_VARS[0]]: UUID })
    assert.equal(got.source, `env:${CONVERSATION_ID_ENV_VARS[0]}`)
  })

  it('does not name a foreign variable anywhere in the resolver', () => {
    // Belt and braces: the assertions above go through the function, this one
    // reads the file, so re-adding a name without wiring it still fails.
    const src = fs.readFileSync(new URL('./remote-control-state.mjs', import.meta.url), 'utf8')
    const resolver = src.slice(src.indexOf('export function detectLocalId'))
    const body = resolver.slice(0, resolver.indexOf('\n}'))
    for (const name of FOREIGN_ENV_VARS) {
      assert.equal(body.includes(name), false, `detectLocalId still names ${name}`)
    }
  })
})

describe('a bond belongs to one agent as well as one conversation', () => {
  const state = (agent, localId, connectionId) => ({
    mtime: 1,
    raw: { enabled: true, connection_id: connectionId, agent_name: agent, local_id: localId },
  })

  it('will not hand this plugin another agent\'s connection on an id match', () => {
    // A conversation id is unique to its host, not across hosts. Matching the
    // id alone is what would let a foreign id reach a live connection.
    const theirs = state('Claude Code', UUID, 'conn-claude')
    assert.equal(selectBoundState([theirs], UUID, AGENT_NAME), null)
  })

  it('matches our own bond on the same id', () => {
    const mine = state(AGENT_NAME, UUID, 'conn-mine')
    assert.equal(selectBoundState([mine], UUID, AGENT_NAME)?.connection_id, 'conn-mine')
  })

  it('picks ours when both hosts hold a bond for the same id', () => {
    const theirs = state('Grok Build', UUID, 'conn-theirs')
    const mine = state(AGENT_NAME, UUID, 'conn-mine')
    assert.equal(selectBoundState([theirs, mine], UUID, AGENT_NAME)?.connection_id, 'conn-mine')
  })

  it('still falls back to our single enabled connection when there is no id', () => {
    // Preserved from memory f90e2ff9: a host that exposes no conversation id
    // resolves to its one enabled connection, and two or more fail closed.
    const mine = state(AGENT_NAME, null, 'conn-mine')
    assert.equal(selectBoundState([mine], null, AGENT_NAME)?.connection_id, 'conn-mine')
    const second = state(AGENT_NAME, null, 'conn-two')
    assert.equal(selectBoundState([mine, second], null, AGENT_NAME), null)
  })

  it('never uses another agent\'s connection as the no-id fallback', () => {
    const theirs = state('Codex', null, 'conn-theirs')
    assert.equal(selectBoundState([theirs], null, AGENT_NAME), null)
  })
})
