/**
 * The connection this Cursor conversation is, stamped on Cursor's own DevSpec
 * calls (item 56ba1b79).
 *
 * DevSpec decides who asked for a write from the connection that made it: the
 * command live on it, or the turn the owner typed at its terminal. Cursor's MCP
 * client sends no connection identity of its own, so a write said nothing about
 * where it came from unless the model remembered to pass connection_id — and in
 * a turn typed at the terminal no skill tells it to. This stamps the connection
 * from the bond the plugin already holds for this conversation.
 *
 * connection_id is attribution, never authority: the server accepts only a
 * connection the token owner owns in this project, and judges what it may do.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_NAME } from './agent-identity.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Calls whose SUBJECT is a connection (attach this one, end that one, report on
// this attempt): the model names it on purpose, and a default would aim them.
const CONNECTION_SUBJECT = /(?:^|_)connection(?:_|$)|^report_(?:pickup|keepalive|complete|request)$/

/**
 * The live connection state bound to exactly this conversation, or null. Never
 * another conversation's, never another host's, and never a guess between two:
 * ambiguity stamps nothing, which leaves the call as the model wrote it.
 */
export function readOwnConnectionState(
  conversationId,
  { home = os.homedir(), myPid = undefined, ownedElsewhere = () => false } = {},
) {
  if (typeof conversationId !== 'string' || !conversationId) return null
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  let files
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'))
  } catch {
    return null
  }
  const byId = new Map()
  for (const file of files) {
    let state
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (!state || state.enabled !== true || state.local_id !== conversationId) continue
    if (String(state.agent_name || '').toLowerCase() !== AGENT_NAME.toLowerCase()) continue
    if (typeof state.connection_id !== 'string' || !UUID.test(state.connection_id)) continue
    if (myPid && ownedElsewhere(state, myPid)) continue
    byId.set(state.connection_id, state)
  }
  return byId.size === 1 ? [...byId.values()][0] : null
}

/**
 * The live connection ID bound to exactly this conversation, or null.
 */
export function ownConnectionId(conversationId, opts = {}) {
  return readOwnConnectionState(conversationId, opts)?.connection_id ?? null
}

/**
 * The call with this conversation's connection added, or the call unchanged. A
 * call that already names a connection or a room is left as written: on some tools
 * a connection outranks a named room, and that choice is the model's to make.
 */
export function withOwnConnection(toolName, args, connectionId) {
  if (!connectionId || !args || typeof args !== 'object' || CONNECTION_SUBJECT.test(toolName)) return args
  if (args.connection_id !== undefined || args.session_id !== undefined) return args
  return { ...args, connection_id: connectionId }
}
