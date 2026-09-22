import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  expandFleetRecipe,
  validateFleetRecipe,
  recipeFromHandoffPayload,
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
})
