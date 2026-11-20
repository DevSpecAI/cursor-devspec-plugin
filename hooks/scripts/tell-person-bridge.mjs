/**
 * The agent's own way to tell its person in the room from a turn that owns no command
 * (item 140a7f68): `printf '%s' '{"message":"…"}' | node remote-control-state.mjs tell-person`.
 *
 * When a DevSpec write's result carries `tell_person`, telling the person is the
 * agent's job (`semantics.notice_audience.telling_anyway` in
 * devspec://product/remote-ingress-contract). In a turn that only DevSpec notices or
 * check jobs woke there is no open turn, so an ordinary connection post is refused,
 * and a notice reply cannot carry it either (`tellPersonPost` in notice-reply.mjs says
 * why). The post that lands is DevSpec's speech lane, which needs the connection's
 * capability: a header the model's own MCP client cannot send. So, like the plan,
 * poll and question bridges, this command sends it with the capability of the exact
 * connection this conversation holds, and the model writes only the words.
 *
 * It also notes on the turn that the person was told, so the end-of-turn backstop
 * (`postTellPersonAtStop`) never posts a second copy.
 */

import path from 'node:path'
import { mcpToolsCall } from './mcp-call.mjs'
import { connectionCredential } from './resolve-mcp-auth.mjs'
import { resolveConnectionBridgeContext } from './manage-plan-bridge.mjs'
import { postRefusal, recordPersonTold, tellPersonPost } from './notice-reply.mjs'

/** What `tell-person describe` prints. */
export function describeTellPersonBridge() {
  return {
    command: 'tell-person',
    stdin: { message: 'string: what you tell your person, in plain words' },
    posts: 'your own message in the room this connection is attached to now; it needs no open turn and opens, answers or completes none',
    rule: 'semantics.notice_audience.telling_anyway in devspec://product/remote-ingress-contract',
  }
}

export function validateTellPersonInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'tell-person takes one JSON object: {"message": "…"}'
  const extra = Object.keys(input).filter((key) => key !== 'message')
  if (extra.length > 0) return `tell-person takes only message; remove ${extra.join(', ')}`
  if (typeof input.message !== 'string' || !input.message.trim()) return 'tell-person needs a non-empty message'
  return null
}

/**
 * Post `input.message` for the exact connection this conversation holds. Returns
 * `{ ok: true, result }` with DevSpec's receipt, or `{ ok: false, error, refusal? }`
 * keeping DevSpec's own structured answer (`postRefusal`) when it gave one.
 */
export async function useTellPersonBridge(
  input,
  { localId, agent = 'Cursor', root, cwd, mcpCall = mcpToolsCall, credentialFor = connectionCredential } = {},
) {
  const inputError = validateTellPersonInput(input)
  if (inputError) return { ok: false, error: inputError }
  const bound = resolveConnectionBridgeContext(
    { localId, agent },
    { ...(root ? { root } : {}), ...(cwd ? { cwd } : {}) },
  )
  if (!bound.ok) return bound
  // The speech lane admits only the connection's own token, so its own credential.
  const credential = credentialFor(bound.state)
  if (!credential.ok) return { ok: false, error: credential.error || 'DevSpec sign-in unavailable for this connection' }
  const redact = (text) => String(text ?? '').replace(/dvsc_[A-Za-z0-9_-]+/g, '[redacted]')
  let refusal
  let result
  try {
    result = await mcpCall({
      mcpUrl: credential.mcp_url,
      token: credential.token,
      name: 'post_session_message',
      arguments: tellPersonPost({ connectionId: bound.connectionId, text: input.message.trim(), agentName: agent }),
      connectionCapability: bound.capability,
      timeoutMs: 30_000,
    })
    refusal = postRefusal({ result })
  } catch (error) {
    refusal = postRefusal({ error })
  }
  if (refusal) {
    // Never include request headers or capability values in what is printed.
    const shown = JSON.parse(redact(JSON.stringify(refusal)))
    return { ok: false, error: shown.message || 'DevSpec did not store the message', refusal: shown }
  }
  // The turn record lives beside the connection's state (`<root>/connections`).
  recordPersonTold(bound.connectionId, root ? { dir: path.join(root, 'connections') } : {})
  return { ok: true, result }
}
