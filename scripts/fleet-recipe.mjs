/**
 * Fleet recipe — shared contract with apps/web/lib/cursor-handoff/fleet-recipe.ts
 * (brief ba6bd58e / item 32b51eea). Keep validation rules in sync.
 */

export const FLEET_RECIPE_TOOLS = ['cursor', 'opencode', 'pi']

export const FLEET_RECIPE_MAX_PER_TOOL = 8
export const FLEET_RECIPE_MAX_TOTAL = 24

/**
 * @param {unknown} input
 * @returns {{ ok: true, recipe: Record<string, number>, total: number } | { ok: false, error: string, detail?: string }}
 */
export function validateFleetRecipe(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'empty' }
  }

  const raw = /** @type {Record<string, unknown>} */ (input)
  const keys = Object.keys(raw)
  if (keys.length === 0) return { ok: false, error: 'empty' }

  /** @type {Record<string, number>} */
  const recipe = {}
  let total = 0

  for (const key of keys) {
    if (!FLEET_RECIPE_TOOLS.includes(key)) {
      return { ok: false, error: 'unknown_tool', detail: key }
    }
    const value = raw[key]
    if (value === undefined || value === null || value === 0) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { ok: false, error: 'invalid_count', detail: key }
    }
    if (value > FLEET_RECIPE_MAX_PER_TOOL) {
      return { ok: false, error: 'over_per_tool_cap', detail: key }
    }
    if (value >= 1) {
      recipe[key] = value
      total += value
    }
  }

  if (total < 1) return { ok: false, error: 'empty' }
  if (total > FLEET_RECIPE_MAX_TOTAL) return { ok: false, error: 'over_total_cap' }
  return { ok: true, recipe, total }
}

/**
 * @param {Record<string, number>} recipe
 * @returns {string[]}
 */
export function expandFleetRecipe(recipe) {
  /** @type {string[]} */
  const out = []
  for (const tool of FLEET_RECIPE_TOOLS) {
    const count = recipe[tool] ?? 0
    for (let i = 0; i < count; i++) out.push(tool)
  }
  return out
}

/**
 * Pull a validated recipe off a verified handoff payload (or null).
 * @param {Record<string, unknown> | null | undefined} data
 */
export function recipeFromHandoffPayload(data) {
  if (!data || data.recipe == null) return null
  const validated = validateFleetRecipe(data.recipe)
  return validated.ok ? validated.recipe : null
}
