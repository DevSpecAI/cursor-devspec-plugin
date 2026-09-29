import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkBundle } from '../launcher/check-bundle.mjs'
test('Cursor carries the verified shared launcher and invokes it from its native submit hook', () => {
  assert.ok(checkBundle().files.has('launcher.mjs'))
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  assert.ok(hooks.hooks.beforeSubmitPrompt.some(h => h.command.includes('/scripts/setup-launcher.mjs')))
})
