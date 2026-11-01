#!/usr/bin/env node
/**
 * check-currency — is what Cursor RUNS the commit on origin/staging?
 *
 * Cursor installs a plugin into a commit-keyed cache:
 *   ~/.cursor/plugins/cache/<marketplace>/<plugin>/<SHA>/
 * The marketplace index clone lives at
 *   ~/.cursor/plugins/marketplaces/<host>/<owner>/<repo>/<SHA>/
 * `marketplace update` re-indexes the same resolved SHA rather than moving it,
 * so currency is read from the installed cache directory, not the index.
 *
 * Run from the repo root:  node scripts/check-currency.mjs
 * Exit 0 = current, non-zero = stale / not installed.
 */
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const repo = process.cwd()
const home = os.homedir()

const isDir = (p) => {
  try { return statSync(p).isDirectory() } catch { return false }
}
function git(args) {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim() } catch { return '' }
}

function installedShas() {
  const out = []
  const root = join(home, '.cursor', 'plugins', 'cache')
  if (!existsSync(root)) return out
  for (const mp of readdirSync(root)) {
    const mpDir = join(root, mp)
    if (!isDir(mpDir)) continue
    for (const plugin of readdirSync(mpDir)) {
      const pDir = join(mpDir, plugin)
      if (!isDir(pDir)) continue
      for (const sha of readdirSync(pDir)) {
        const sDir = join(pDir, sha)
        if (isDir(sDir)) out.push({ marketplace: mp, plugin, sha, path: sDir })
      }
    }
  }
  return out
}

function marketplaceShas() {
  const out = []
  const root = join(home, '.cursor', 'plugins', 'marketplaces')
  if (!existsSync(root)) return out
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (!isDir(p)) continue
      if (/^[0-9a-f]{40}$/.test(entry)) {
        out.push({ sha: entry, path: p })
        continue
      }
      walk(p)
    }
  }
  walk(root)
  return out
}

git(['fetch', '--quiet', 'origin', 'staging'])
const origin = git(['rev-parse', 'origin/staging'])
const installed = installedShas()
const indexed = marketplaceShas()

console.log('host: Cursor')
console.log(`origin staging: ${origin || 'UNKNOWN'}`)
console.log('installed cache (what runs):')
if (installed.length === 0) console.log('  (none found under ~/.cursor/plugins/cache)')
for (const i of installed) console.log(`  ${i.sha}  ${i.path}`)
console.log('marketplace index:')
if (indexed.length === 0) console.log('  (none found under ~/.cursor/plugins/marketplaces)')
for (const m of indexed) console.log(`  ${m.sha}  ${m.path}`)

const current = origin !== '' && installed.some((i) => i.sha === origin)
console.log(`currency: ${current ? 'CURRENT' : 'STALE'}`)
process.exit(current ? 0 : 1)
