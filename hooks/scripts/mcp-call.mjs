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

/** HTTP statuses that describe a transient condition, not a verdict on the request. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504])

/** Three attempts over ~1.5s: covers a container swap without making a down server feel hung. */
const CONNECT_ATTEMPTS = 3
const CONNECT_BACKOFF_MS = [300, 1_200]

/**
 * Read the server's typed failure contract off a non-OK response body (DevSpec
 * item 798e2375). A validation outage answers 503 with
 * `{code:'auth_validation_unavailable', retryable:true, credential_type}`; a
 * genuinely rejected credential answers 401 with
 * `{code:'invalid_api_token'|'invalid_connection_capability', retryable:false}`.
 *
 * Without this the status and the machine code exist only inside the error's
 * message string, so every caller has to regex them back out — the pattern that
 * turned transient 503s into "your token is revoked, go log in" elsewhere.
 *
 * The server's word is `serverCode`, deliberately NOT `code`: in this module
 * `err.code` already means the ABORT reason ('timeout' | 'owner_gone') and callers
 * switch on it. Exported for tests.
 */
export function readServerFailure(status, bodyText) {
  const out = {
    status: Number.isInteger(status) ? status : null,
    serverCode: null,
    retryable: null,
    credentialType: null,
  }
  const text = typeof bodyText === 'string' ? bodyText : ''
  const start = text.indexOf('{')
  // A proxy's body-less "Bad Gateway" has no JSON; the status alone must carry it.
  if (start < 0) return out
  let body = null
  try {
    body = JSON.parse(text.slice(start))
  } catch {
    body = null
  }
  if (!body || typeof body !== 'object') return out
  if (typeof body.code === 'string') out.serverCode = body.code
  if (typeof body.retryable === 'boolean') out.retryable = body.retryable
  if (body.credential_type === 'api_token' || body.credential_type === 'connection_capability') {
    out.credentialType = body.credential_type
  }
  return out
}

/**
 * Should this failure be tried again? The server's explicit word wins over the
 * status, so a credential it has actually rejected is never retried however the
 * transport dressed it up. A body-less 502/503 from a proxy mid-redeploy has no
 * word to offer, hence the status fallback. A deliberate abort is never retried.
 * Exported for tests.
 */
export function isRetryableHttpFailure(err) {
  if (!err || typeof err !== 'object') return false
  if (err.code === 'owner_gone' || err.code === 'timeout') return false
  if (err.retryable === false) return false
  if (err.retryable === true) return true
  return RETRYABLE_HTTP_STATUSES.has(err.status)
}

/**
 * `mcpToolsCall` with a bounded retry, for ONE-SHOT paths like connect where a
 * transient failure is the whole command failing. Long-running pollers must keep
 * using the bare call — they have their own tuned recoverable-end handling and a
 * second layer would change it.
 *
 * `sleepFn` and `call` are injected so tests do not pay the backoff. Exported for tests.
 */
export async function mcpToolsCallWithRetry(args = {}, retryOptions = {}) {
  const {
    attempts = CONNECT_ATTEMPTS,
    backoff = CONNECT_BACKOFF_MS,
    onRetry = null,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    call = mcpToolsCall,
  } = retryOptions
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(args)
    } catch (e) {
      if (attempt >= attempts - 1 || !isRetryableHttpFailure(e)) throw e
      if (onRetry) onRetry(e, attempt)
      await sleepFn(backoff[attempt] ?? backoff[backoff.length - 1] ?? 1_200)
    }
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
    // Message text is deliberately unchanged — logs and existing matching read it.
    const err = new Error(`MCP HTTP ${res.status}: ${text.slice(0, 400)}`)
    Object.assign(err, readServerFailure(res.status, text))
    throw err
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
