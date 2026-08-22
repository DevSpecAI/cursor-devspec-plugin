#!/usr/bin/env node
/**
 * MCP HTTP call timeouts (item 0c2fb922). A dropped gateway used to hang
 * wait/mirror-turn/report_complete forever because fetch has no default timeout.
 * Run: node --test hooks/scripts/mcp-call.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_MCP_CALL_TIMEOUT_MS, mcpRequestHeaders } from './mcp-call.mjs'

describe('DEFAULT_MCP_CALL_TIMEOUT_MS', () => {
  it('bounds non-hold MCP tools/call at 30s', () => {
    assert.equal(DEFAULT_MCP_CALL_TIMEOUT_MS, 30_000)
  })
})

describe('connection capability header', () => {
  it('is absent from ordinary MCP calls and present only for a valid bridge value', () => {
    assert.equal(mcpRequestHeaders({ token: 'dvs_token' })['X-DevSpec-Connection-Capability'], undefined)
    assert.equal(mcpRequestHeaders({ token: 'dvs_token', connectionCapability: 'model-value' })['X-DevSpec-Connection-Capability'], undefined)
    assert.equal(
      mcpRequestHeaders({ token: 'dvs_token', connectionCapability: 'dvsc_hidden' })['X-DevSpec-Connection-Capability'],
      'dvsc_hidden',
    )
  })
})
