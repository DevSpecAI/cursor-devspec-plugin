#!/usr/bin/env node
/**
 * MCP HTTP call timeouts (item 0c2fb922). A dropped gateway used to hang
 * wait/mirror-turn/report_complete forever because fetch has no default timeout.
 * Run: node --test hooks/scripts/mcp-call.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_MCP_CALL_TIMEOUT_MS } from './mcp-call.mjs'

describe('DEFAULT_MCP_CALL_TIMEOUT_MS', () => {
  it('bounds non-hold MCP tools/call at 30s', () => {
    assert.equal(DEFAULT_MCP_CALL_TIMEOUT_MS, 30_000)
  })
})
