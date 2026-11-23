/**
 * The poller opens DevSpec's push stream (GET <mcp url>/connection-stream) the moment
 * it starts, alongside its JSON-RPC posts (item 59afbe7e). A stub MCP server in a test
 * therefore has to answer that request too: a stub that reads every request body as
 * JSON crashes on the stream's empty GET, and takes the test down with it before it has
 * checked anything (item 507705dd).
 *
 * Call `isPushStreamRequest` first in a stub's request handler, then either refuse the
 * stream (the poller falls back to held long polls, exactly as it does against a server
 * whose stream is unavailable) or open one and push frames down it.
 */

/** Whether this request is the poller opening DevSpec's push stream. */
export function isPushStreamRequest(request) {
  if (request.method !== 'GET') return false
  return new URL(request.url ?? '/', 'http://stub.invalid').pathname.endsWith('/connection-stream')
}

/** Refuse the push stream, as a server without one would: the poller holds polls instead. */
export function refusePushStream(response) {
  response.writeHead(404, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: 'not_found' }))
}

/**
 * Open a push stream and greet it the way DevSpec does, with a `hello` frame. Returns
 * `send(event, data)` to push a frame and `close()` to end the stream from the server.
 */
export function openPushStream(response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (event, data = {}) => {
    if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  send('hello', {})
  return {
    send,
    close: () => {
      if (!response.writableEnded) response.end()
    },
  }
}
