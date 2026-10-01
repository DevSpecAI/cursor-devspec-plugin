#!/usr/bin/env node
/**
 * Human-page links are built from the DevSpec host the plugin is using.
 * Run: node --test hooks/scripts/app-pages.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentsPageLinks, agentsPageUrl, resolveAppBaseUrl } from './app-pages.mjs'

const none = { env: {} }

describe('resolveAppBaseUrl', () => {
  it('maps each settled API host to its app host', () => {
    assert.equal(resolveAppBaseUrl('https://api.devspec.ai/api/mcp?tool_namespace=devspec', none), 'https://app.devspec.ai')
    assert.equal(resolveAppBaseUrl('https://api.devspecstaging.com/api/mcp', none), 'https://app.devspecstaging.com')
    assert.equal(resolveAppBaseUrl('https://api.devspecstaging.com', none), 'https://app.devspecstaging.com')
    assert.equal(resolveAppBaseUrl('https://app.devspecstaging.com', none), 'https://app.devspecstaging.com')
  })

  it('prefers an explicit DEVSPEC_APP_URL', () => {
    assert.equal(
      resolveAppBaseUrl('https://api.devspec.ai/api/mcp', { env: { DEVSPEC_APP_URL: 'https://app.devspecstaging.com/' } }),
      'https://app.devspecstaging.com',
    )
  })

  it('keeps a loopback dev server on its own origin', () => {
    assert.equal(resolveAppBaseUrl('http://localhost:3000/api/mcp', none), 'http://localhost:3000')
  })

  it('never invents a hostname from an unknown or unreadable API URL', () => {
    assert.equal(resolveAppBaseUrl('https://api.example.test/api/mcp', none), 'https://app.devspec.ai')
    assert.equal(resolveAppBaseUrl('api.devspec.ai', none), 'https://app.devspec.ai')
    assert.equal(resolveAppBaseUrl(null, none), 'https://app.devspec.ai')
  })
})

describe('Agents page links', () => {
  it('is /settings/agents on the app host of the environment in use', () => {
    assert.equal(agentsPageUrl('https://api.devspec.ai/api/mcp', none), 'https://app.devspec.ai/settings/agents')
    assert.equal(agentsPageUrl('https://api.devspecstaging.com/api/mcp', none), 'https://app.devspecstaging.com/settings/agents')
  })

  it('links each distinct environment once, in order', () => {
    assert.equal(
      agentsPageLinks(['https://api.devspecstaging.com/api/mcp', 'https://api.devspecstaging.com/api/mcp?tool_namespace=devspec'], none),
      'https://app.devspecstaging.com/settings/agents',
    )
    assert.equal(
      agentsPageLinks(['https://api.devspec.ai/api/mcp', 'https://api.devspecstaging.com/api/mcp'], none),
      'https://app.devspec.ai/settings/agents or https://app.devspecstaging.com/settings/agents',
    )
    assert.equal(agentsPageLinks([], none), 'https://app.devspec.ai/settings/agents')
  })
})
