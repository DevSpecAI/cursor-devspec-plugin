import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  expandFleetRecipe,
  validateFleetRecipe,
  recipeFromHandoffPayload,
  resolveFleetSpawnPrompt,
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

  it('resolveFleetSpawnPrompt defaults null/empty to bare remote Connect', () => {
    assert.equal(resolveFleetSpawnPrompt(null), FLEET_DEFAULT_REMOTE_PROMPT)
    assert.equal(resolveFleetSpawnPrompt(undefined), FLEET_DEFAULT_REMOTE_PROMPT)
    assert.equal(resolveFleetSpawnPrompt(''), FLEET_DEFAULT_REMOTE_PROMPT)
    assert.equal(resolveFleetSpawnPrompt('   '), FLEET_DEFAULT_REMOTE_PROMPT)
    assert.equal(FLEET_DEFAULT_REMOTE_PROMPT, 'Run the `devspec.remote` skill.')
  })

  it('resolveFleetSpawnPrompt keeps a non-empty handoff prompt', () => {
    const attach =
      'Run the `devspec.remote` skill with this input: --session 130c9d24-1011-4e0c-a391-ee2ac561013e'
    assert.equal(resolveFleetSpawnPrompt(attach), attach)
    assert.equal(resolveFleetSpawnPrompt(`  ${attach}  `), attach)
  })
})
