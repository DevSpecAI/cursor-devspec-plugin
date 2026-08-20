/**
 * Typed Cursor host-control boundary.
 *
 * Cursor's detached local poller has no supported in-process lifecycle API today.
 * Runtime handlers are therefore empty and every verb remains pending/unacked.
 * Tests and a future real host bridge may inject an exact verb handler; only a
 * successful handler result authorizes control_ack.
 */
export async function executeCursorHostControl(control, handlers = {}) {
  if (!control || typeof control !== 'object' || typeof control.id !== 'string' ||
      typeof control.verb !== 'string') {
    return { executed: false, ackId: null, reason: 'malformed_control' }
  }
  const handler = handlers[control.verb]
  if (typeof handler !== 'function') {
    return { executed: false, ackId: null, reason: 'unsupported_by_cursor_host' }
  }
  try {
    const result = await handler(control.args ?? {}, control)
    if (result?.executed !== true) {
      return { executed: false, ackId: null, reason: result?.reason || 'host_declined_control' }
    }
    return {
      executed: true,
      ackId: control.id,
      reason: null,
      ...(result.modelCatalog ? { modelCatalog: result.modelCatalog } : {}),
    }
  } catch (error) {
    return {
      executed: false,
      ackId: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
