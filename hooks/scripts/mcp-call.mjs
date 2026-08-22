#!/usr/bin/env node
/**
 * Minimal JSON-RPC tools/call against DevSpec streamable HTTP MCP.
 *
 * Optional `timeoutMs` and `isAlive` exist for the LONG-POLL tick (`poll_connection`
 * holds a request open for ~25s):
 *   - timeoutMs: fetch has no default timeout, so a silently-dropped TCP connection
 *     would otherwise wedge a held request — and therefore the poller's heartbeat —
 *     forever. Always set a ceiling above the server's own hold.
 *   - isAlive: polled while the request is in flight. Returning false aborts it, so a
 *     poller whose owning agent process died tears down immediately instead of after
 *     the hold expires (the anti-zombie contract).
 * Both throw an Error carrying `code` ('timeout' | 'owner_gone') so callers can tell a
 * deliberate abort from a network failure.
 *
 * Non-hold calls that omit timeoutMs use DEFAULT_MCP_CALL_TIMEOUT_MS (30s). A dead
 * gateway used to freeze wait/mirror-turn/report_complete forever (0c2fb922). Long-poll
 * must pass an explicit timeout above the server hold.
 */

/** Ceiling for MCP tools/call when the caller does not pass timeoutMs. */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 30_000

export function mcpRequestHeaders({ token, connectionCapability = null }) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(typeof connectionCapability === 'string' && connectionCapability.startsWith('dvsc_')
      ? { 'X-DevSpec-Connection-Capability': connectionCapability }
      : {}),
  }
}

export async function mcpToolsCall({
  mcpUrl,
  token,
  name,
  arguments: toolArgs,
  timeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS,
  isAlive = null,
  aliveCheckMs = 2_000,
  connectionCapability = null,
  includeMeta = false,
}) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: toolArgs || {} },
  }

  const controller = new AbortController()
  let abortCode = null
  let timeoutTimer = null
  let aliveTimer = null
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      abortCode = 'timeout'
      controller.abort()
    }, timeoutMs)
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
  }
  if (typeof isAlive === 'function') {
    aliveTimer = setInterval(() => {
      let alive = true
      try {
        alive = isAlive() !== false
      } catch {
        alive = true // a broken liveness probe must never kill a healthy request
      }
      if (!alive) {
        abortCode = 'owner_gone'
        controller.abort()
      }
    }, aliveCheckMs)
    if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
  }

  let res
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: mcpRequestHeaders({ token, connectionCapability }),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    if (abortCode) {
      const err = new Error(`MCP call ${name} aborted: ${abortCode}`)
      err.code = abortCode
      throw err
    }
    throw e
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (aliveTimer) clearInterval(aliveTimer)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 400)}`)
  }

  // Parse JSON or SSE-ish responses
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // SSE: lines like data: {...}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        try {
          payload = JSON.parse(trimmed.slice(5).trim())
          break
        } catch {
          /* continue */
        }
      }
    }
  }

  if (!payload) {
    throw new Error(`Unparseable MCP response: ${text.slice(0, 200)}`)
  }
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error))
  }

  // tools/call result content is usually { content: [{ type:'text', text:'...' }], isError? }
  const content = payload.result?.content
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
    const joined = textParts.join('\n')
    if (payload.result?.isError) {
      throw new Error(joined || 'MCP tool error')
    }
    let data
    try {
      data = JSON.parse(joined)
    } catch {
      const { _meta: _hiddenMeta, ...publicResult } = payload.result ?? {}
      data = { raw: joined, result: publicResult }
    }
    return includeMeta ? { data, meta: payload.result?._meta ?? null } : data
  }
  const source = payload.result ?? payload
  const hiddenMeta = source && typeof source === 'object' && !Array.isArray(source)
    ? source._meta ?? null
    : null
  const data = hiddenMeta
    ? Object.fromEntries(Object.entries(source).filter(([key]) => key !== '_meta'))
    : source
  return includeMeta ? { data, meta: hiddenMeta } : data
}
