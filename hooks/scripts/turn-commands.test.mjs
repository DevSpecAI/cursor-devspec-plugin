#!/usr/bin/env node
/**
 * turn-commands.mjs: which room command a pickup starts and what a turn's end names
 * (item a4391300). The poller, the Stop hook and the wait's reply re-arm all build
 * their report_pickup and report_complete arguments here.
 * Run: node --test hooks/scripts/turn-commands.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearTurnCommands,
  commandsHandedOver,
  completionArguments,
  pickupArguments,
  readTurnCommands,
  recordTurnCommands,
  turnCommandsPath,
} from './turn-commands.mjs'
import { FIXTURE_ID, fixtureCommand, fixtureUuid } from './remote-ingress-test-fixtures.mjs'

const CONNECTION = FIXTURE_ID.connection
const A = { turnId: FIXTURE_ID.turn, messageId: FIXTURE_ID.message }
const B = { turnId: fixtureUuid(202), messageId: fixtureUuid(201) }
const LOCAL_ATTEMPT = fixtureUuid(300)

function command(identity) {
  const base = fixtureCommand()
  return { ...base, message_id: identity.messageId, delivery: { ...base.delivery, turn_id: identity.turnId } }
}

describe('commandsHandedOver', () => {
  it('names each delivered command by its turn and message, in the order delivered', () => {
    assert.deepEqual(commandsHandedOver([command(A), command(B)]), [A, B])
  })

  it('leaves out a command it cannot name, and names a repeated one once', () => {
    const noTurn = { ...command(B), delivery: { provenance_ref: FIXTURE_ID.provenance } }
    assert.deepEqual(commandsHandedOver([command(A), noTurn, command(A), null]), [A])
    assert.deepEqual(commandsHandedOver(undefined), [])
  })
})

describe('pickupArguments', () => {
  it('starts exactly the command handed over, never the newest one waiting', () => {
    assert.deepEqual(pickupArguments(CONNECTION, A), {
      connection_id: CONNECTION,
      command_turn_id: A.turnId,
      command_message_id: A.messageId,
    })
  })
})

describe('completionArguments', () => {
  it('names every command that started the turn, one report each, with the reason', () => {
    assert.deepEqual(completionArguments({ connectionId: CONNECTION, commands: [A, B], reason: 'turn_end' }), [
      { connection_id: CONNECTION, command_turn_id: A.turnId, command_message_id: A.messageId, reason: 'turn_end' },
      { connection_id: CONNECTION, command_turn_id: B.turnId, command_message_id: B.messageId, reason: 'turn_end' },
    ])
  })

  it('names the terminal turn the owner typed beside them', () => {
    assert.deepEqual(
      completionArguments({ connectionId: CONNECTION, commands: [A], localAttemptId: LOCAL_ATTEMPT, reason: 'turn_end' }),
      [
        { connection_id: CONNECTION, command_turn_id: A.turnId, command_message_id: A.messageId, reason: 'turn_end' },
        { connection_id: CONNECTION, attempt_id: LOCAL_ATTEMPT, reason: 'turn_end' },
      ],
    )
  })

  it('says a turn that started with neither is unbound, so it can never finish a command', () => {
    assert.deepEqual(completionArguments({ connectionId: CONNECTION, reason: 'max_turn_ms' }), [
      { connection_id: CONNECTION, command_turn_unbound: true, reason: 'max_turn_ms' },
    ])
    assert.deepEqual(completionArguments({ connectionId: CONNECTION, localAttemptId: 'not-an-attempt', reason: 'turn_end' }), [
      { connection_id: CONNECTION, command_turn_unbound: true, reason: 'turn_end' },
    ])
  })

  it('every report carries exactly one identity', () => {
    const identities = ['command_turn_id', 'attempt_id', 'command_turn_unbound']
    const cases = [
      { commands: [A, B], localAttemptId: LOCAL_ATTEMPT },
      { commands: [], localAttemptId: LOCAL_ATTEMPT },
      { commands: [], localAttemptId: null },
    ]
    for (const input of cases) {
      for (const args of completionArguments({ connectionId: CONNECTION, reason: 'turn_end', ...input })) {
        assert.equal(identities.filter((key) => key in args).length, 1, JSON.stringify(args))
      }
    }
  })
})

describe('the record of the commands that started a turn', () => {
  it('is read back as written, replaces an earlier turn\'s record, and is gone once cleared', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-turn-commands-'))
    try {
      assert.deepEqual(readTurnCommands(CONNECTION, { dir }), [])
      assert.equal(recordTurnCommands(CONNECTION, [A], { dir }), true)
      assert.equal(recordTurnCommands(CONNECTION, [B, B], { dir }), true)
      assert.deepEqual(readTurnCommands(CONNECTION, { dir }), [B])
      assert.equal(fs.statSync(turnCommandsPath(CONNECTION, dir)).mode & 0o777, 0o600)
      clearTurnCommands(CONNECTION, { dir })
      assert.equal(fs.existsSync(turnCommandsPath(CONNECTION, dir)), false)
      assert.deepEqual(readTurnCommands(CONNECTION, { dir }), [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records nothing when there is no command to name, and an unreadable record names nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-turn-commands-'))
    try {
      assert.equal(recordTurnCommands(CONNECTION, [], { dir }), false)
      assert.equal(fs.existsSync(turnCommandsPath(CONNECTION, dir)), false)
      fs.writeFileSync(turnCommandsPath(CONNECTION, dir), '{torn')
      assert.deepEqual(readTurnCommands(CONNECTION, { dir }), [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
