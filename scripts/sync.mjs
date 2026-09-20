#!/usr/bin/env node
/**
 * sync — pull origin/staging, then confirm what Cursor actually runs.
 *
 * Cursor pins the commit at marketplace add time; `marketplace update` does not
 * move it. The refresh is remove + re-add the marketplace, then install via
 * /plugins in the TUI. Only the first half is scriptable, and only when the
 * `cursor-agent` CLI is present; this script reports the rest.
 *
 * Usage: node scripts/sync.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.trim()
  }
}

console.log('== Cursor: pull origin staging ==')
console.log(sh('git', ['pull', '--ff-only', 'origin', 'staging']) || 'Already up to date.')
console.log('')

const check = spawnSync('node', [join(repo, 'scripts', 'check-currency.mjs')], { cwd: repo, stdio: 'inherit' })
if ((check.status ?? 1) !== 0) {
  console.log('Next step (manual): launch the Cursor agent against this local clone — the development path, not the marketplace:')
  console.log(`  cursor-agent --plugin-dir "${repo}"`)
  console.log('The marketplace route is the customer path only. Do NOT use `marketplace update` — it re-indexes the same pinned commit.')
}
process.exit(check.status ?? 1)
