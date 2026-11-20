#!/usr/bin/env node
/**
 * plugin-root — which installed copy of this plugin the skills run.
 *
 *   node plugin-root.mjs        prints the folder of the newest installed copy
 *
 * Cursor keeps one copy of an installed plugin per commit
 * (~/.cursor/plugins/cache/<marketplace>/<plugin>/<commit>/), and a local copy
 * lives at ~/.cursor/plugins/local/<name>/. Older copies stay on disk after an
 * update, so the first match a file search happens to list is an arbitrary
 * copy, and a connect could start an old poller beside new hooks. The skills
 * ask this script instead, and every copy of it gives the same answer, because
 * it looks at all of them rather than at the folder it runs from.
 *
 * The newest copy has the highest plugin version, compared as a version: 0.4.14
 * is above 0.4.9, which text order gets backwards. A copy whose version cannot
 * be read comes after every copy whose version can, since nothing says how new
 * it is. Within one version, or among unreadable ones, the most recently
 * modified manifest wins; the manifest is the file that carries the version,
 * so it is written when a copy arrives. The folder path settles any remaining
 * tie, so the answer never depends on the order the disk lists folders in.
 *
 * With no copy found it prints nothing on stdout, says so on stderr and exits
 * 1, so a caller never goes on with an empty path.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLUGIN_NAME } from './connection-version.mjs'
import { isDirectRun } from './is-direct-run.mjs'

const MANIFEST = path.join('.cursor-plugin', 'plugin.json')
/** The helper the remote skills run; a folder without it cannot serve them. */
const HELPER = path.join('hooks', 'scripts', 'remote-control-state.mjs')
/** Cursor's marketplace index: clones it reads plugins from, not what it installed. */
const INDEX_DIR = 'marketplaces'
/**
 * How deep under ~/.cursor/plugins a copy may sit. An installed copy is 4 levels
 * down (cache/<marketplace>/<plugin>/<commit>) and a local one 2. 6 keeps the
 * reach of the file search the skills used before (find -maxdepth 9 on a helper
 * 3 levels inside the copy), so no copy that search found is lost.
 */
const MAX_DEPTH = 6

export function defaultPluginsDir(home = os.homedir()) {
  return path.join(home, '.cursor', 'plugins')
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** A semantic version as comparable parts, or null when it is not one. */
export function parseVersion(value) {
  const match = typeof value === 'string' ? SEMVER.exec(value.trim()) : null
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

/** Semantic-version precedence of two parsed versions: negative, 0 or positive. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1
  // A release outranks its own pre-releases: 1.0.0 is above 1.0.0-rc.1.
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1
    if (xNum !== yNum) return xNum ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

function isFile(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

/** The copy of this plugin in `dir`, or null when `dir` is not one. */
function readCopy(dir, name) {
  const file = path.join(dir, MANIFEST)
  let manifest
  let modifiedMs
  try {
    modifiedMs = fs.statSync(file).mtimeMs
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return null }
  if (!manifest || manifest.name !== name || !isFile(path.join(dir, HELPER))) return null
  const version = typeof manifest.version === 'string' ? manifest.version : null
  return { path: dir, version, parsed: parseVersion(version), modifiedMs }
}

function newestFirst(a, b) {
  if (a.parsed && b.parsed) {
    const byVersion = compareVersions(b.parsed, a.parsed)
    if (byVersion) return byVersion
  } else if (a.parsed || b.parsed) {
    return a.parsed ? -1 : 1
  }
  if (a.modifiedMs !== b.modifiedMs) return b.modifiedMs - a.modifiedMs
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * Every installed copy of this plugin under `pluginsDir`, newest first.
 * A symbolic link is taken when it points straight at a copy (a local checkout
 * linked in), but never walked through: a link back up the tree would
 * otherwise make the search endless.
 */
export function findPluginCopies({ pluginsDir = defaultPluginsDir(), name = PLUGIN_NAME } = {}) {
  const copies = []
  const visit = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (depth === 1 && entry.name === INDEX_DIR) continue
      const walkable = entry.isDirectory()
      if (!walkable && !entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      const copy = readCopy(full, name)
      if (copy) copies.push(copy)
      else if (walkable && depth < MAX_DEPTH) visit(full, depth + 1)
    }
  }
  visit(pluginsDir, 1)
  return copies.sort(newestFirst)
}

/** The folder of the newest installed copy of this plugin, or null when there is none. */
export function findPluginRoot(options = {}) {
  return findPluginCopies(options)[0]?.path ?? null
}

if (isDirectRun(import.meta.url)) {
  const root = findPluginRoot()
  if (root) {
    process.stdout.write(`${root}\n`)
  } else {
    process.stderr.write(`No installed copy of the DevSpec plugin for Cursor was found in ${defaultPluginsDir()}. Install it in Cursor (or reinstall it), then try again.\n`)
    process.exitCode = 1
  }
}
