import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  expandFleetRecipe,
  validateFleetRecipe,
  recipeFromHandoffPayload,
  resolveFleetSpawnPrompt,
  fleetRemotePromptForTool,
  shortSessionId,
  sessionIdFromHandoffPayload,
  FLEET_DEFAULT_REMOTE_PROMPT,
} from './fleet-recipe.mjs'

describe('fleet-recipe', () => {
  it('expands {cursor:2,pi:1} into three spawn tools', () => {
    const validated = validateFleetRecipe({ cursor: 2, pi: 1 })
    assert.equal(validated.ok, true)
    assert.deepEqual(expandFleetRecipe(validated.recipe), ['cursor', 'cursor', 'pi'])
  })

  it('recipeFromHandoffPayload returns null without recipe', () => {
    assert.equal(recipeFromHandoffPayload({ repo: 'a/b' }), null)
  })

  it('recipeFromHandoffPayload validates embedded recipe', () => {
    assert.deepEqual(
      recipeFromHandoffPayload({ repo: 'a/b', recipe: { cursor: 1, opencode: 0 } }),
      { cursor: 1 },
    )
  })

  it('sessionIdFromHandoffPayload reads sessionId or session_id', () => {
    assert.equal(sessionIdFromHandoffPayload(null), null)
    assert.equal(sessionIdFromHandoffPayload({}), null)
    assert.equal(
      sessionIdFromHandoffPayload({ sessionId: '130c9d24-1011-4e0c-a391-ee2ac561013e' }),
      '130c9d24-1011-4e0c-a391-ee2ac561013e',
    )
    assert.equal(sessionIdFromHandoffPayload({ session_id: 'abc' }), 'abc')
  })

  it('shortSessionId matches web OpenCode attach short code', () => {
    assert.equal(shortSessionId('130c9d24-1011-4e0c-a391-ee2ac561013e'), '130c9d24')
    assert.equal(shortSessionId(''), '')
  })

  it('resolveFleetSpawnPrompt keeps a non-empty handoff prompt', () => {
    const attach =
      'Run the `devspec.remote` skill with this input: --session 130c9d24-1011-4e0c-a391-ee2ac561013e'
    assert.equal(resolveFleetSpawnPrompt(attach), attach)
    assert.equal(resolveFleetSpawnPrompt(`  ${attach}  `), attach)
  })

  it('resolveFleetSpawnPrompt uses per-tool single-launch shape when empty', () => {
    assert.equal(resolveFleetSpawnPrompt(null, { tool: 'opencode' }), '/devspec.remote')
    assert.equal(resolveFleetSpawnPrompt('', { tool: 'pi' }), '/devspec.remote')
    assert.equal(resolveFleetSpawnPrompt(null, { tool: 'cursor' }), FLEET_DEFAULT_REMOTE_PROMPT)
    assert.equal(FLEET_DEFAULT_REMOTE_PROMPT, 'Run the `devspec.remote` skill.')
  })

  it('resolveFleetSpawnPrompt attaches with --session like single OpenCode launch', () => {
    const sessionId = '130c9d24-1011-4e0c-a391-ee2ac561013e'
    assert.equal(
      resolveFleetSpawnPrompt(null, { tool: 'opencode', sessionId }),
      '/devspec.remote --session 130c9d24',
    )
    assert.equal(
      resolveFleetSpawnPrompt(null, { tool: 'pi', sessionId }),
      '/devspec.remote --session 130c9d24',
    )
    assert.match(
      resolveFleetSpawnPrompt(null, { tool: 'cursor', sessionId }),
      /devspec\.remote.*--session 130c9d24/,
    )
  })

  it('fleetRemotePromptForTool matches single-launch attach for OpenCode', () => {
    assert.equal(
      fleetRemotePromptForTool('opencode', '130c9d24-1011-4e0c-a391-ee2ac561013e'),
      '/devspec.remote --session 130c9d24',
    )
  })
})
