import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ROOM_MESSAGE_MAX_CHARS, fitRoomMessage, roomMessageTooLong } from './room-message.mjs'

// Guards the one limit on what this plugin posts into a room: the server's own
// 100,000-character message limit, applied visibly and never below it.
describe('fitting text into one room message', () => {
  it('delivers text up to the limit whole', () => {
    const text = 'a'.repeat(ROOM_MESSAGE_MAX_CHARS)
    assert.equal(fitRoomMessage(text), text)
    assert.equal(fitRoomMessage('short'), 'short')
  })

  it('past the limit keeps the start, says how much is missing and where it is, and still fits', () => {
    const text = `BEGIN${'b'.repeat(ROOM_MESSAGE_MAX_CHARS + 5_000)}`
    const out = fitRoomMessage(text, { whereRest: 'The full text is in the terminal.' })
    assert.ok(out.length <= ROOM_MESSAGE_MAX_CHARS)
    assert.ok(out.startsWith('BEGIN'))
    const match = /… ([\d,]+) more characters are not shown: a DevSpec room message holds at most 100,000 characters\. The full text is in the terminal\.$/.exec(out)
    assert.ok(match, out.slice(-200))
    // The count is exactly what was left out.
    const omitted = Number(match[1].replace(/,/g, ''))
    assert.equal(out.length - match[0].length - 2 + omitted, text.length)
  })

  it('refuses rather than cuts text the agent can shorten, naming both numbers', () => {
    assert.equal(roomMessageTooLong('x'.repeat(ROOM_MESSAGE_MAX_CHARS)), null)
    const why = roomMessageTooLong('x'.repeat(ROOM_MESSAGE_MAX_CHARS + 1))
    assert.match(why, /100,001 characters/)
    assert.match(why, /at most 100,000/)
  })
})
