import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { materializeHandoffData } from './handoff-verify.mjs'
import { expandFleetRecipe, recipeFromHandoffPayload } from './fleet-recipe.mjs'

describe('handoff-verify materializeHandoffData', () => {
  const base = {
    repo: 'DevSpecAI/DevSpecV2',
    exp: Math.floor(Date.now() / 1000) + 3600,
    title: 'Warm local agents',
    surface: 'cli',
    tool: 'cursor',
  }

  it('passes recipe through so recipeFromHandoffPayload can fan out (item 41f7bef6)', () => {
    const verified = materializeHandoffData({
      ...base,
      recipe: { cursor: 2, opencode: 1, pi: 1 },
    })
    assert.equal(verified.ok, true)
    if (!verified.ok) return

    assert.deepEqual(verified.data.recipe, { cursor: 2, opencode: 1, pi: 1 })
    const recipe = recipeFromHandoffPayload(verified.data)
    assert.deepEqual(recipe, { cursor: 2, opencode: 1, pi: 1 })
    assert.deepEqual(expandFleetRecipe(recipe), [
      'cursor',
      'cursor',
      'opencode',
      'pi',
    ])
  })

  it('passes resumeChatId through when present', () => {
    const verified = materializeHandoffData({
      ...base,
      resumeChatId: '02f20d53-6cfb-49a7-a661-5fe6975ecb61',
    })
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.data.resumeChatId, '02f20d53-6cfb-49a7-a661-5fe6975ecb61')
  })

  it('omits recipe when absent (single-agent handoffs stay single)', () => {
    const verified = materializeHandoffData(base)
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.data.recipe, undefined)
    assert.equal(recipeFromHandoffPayload(verified.data), null)
  })

  it('drops non-object recipe values', () => {
    const verified = materializeHandoffData({ ...base, recipe: 'nope' })
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.data.recipe, undefined)
  })
})
