import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compareVersions, findPluginCopies, findPluginRoot, parseVersion } from './plugin-root.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
/** The finder and everything it imports, copied into fixture copies so they can run it. */
const FINDER_FILES = ['plugin-root.mjs', 'connection-version.mjs', 'agent-identity.mjs', 'is-direct-run.mjs']

let home
let plugins
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-plugin-root-'))
  plugins = path.join(home, '.cursor', 'plugins')
  fs.mkdirSync(plugins, { recursive: true })
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

/** Lay out one copy of a plugin, the way Cursor installs it, with its manifest's mtime set. */
function copy(relative, { name = 'devspec', version, modified = 1_700_000_000, helper = true, finder = false, manifestDir = '.cursor-plugin' } = {}) {
  const dir = path.join(plugins, relative)
  fs.mkdirSync(path.join(dir, manifestDir), { recursive: true })
  fs.mkdirSync(path.join(dir, 'hooks', 'scripts'), { recursive: true })
  const manifest = path.join(dir, manifestDir, 'plugin.json')
  fs.writeFileSync(manifest, JSON.stringify({ name, ...(version === undefined ? {} : { version }) }))
  fs.utimesSync(manifest, modified, modified)
  if (helper) fs.writeFileSync(path.join(dir, 'hooks', 'scripts', 'remote-control-state.mjs'), '// helper\n')
  if (finder) for (const file of FINDER_FILES) fs.copyFileSync(path.join(here, file), path.join(dir, 'hooks', 'scripts', file))
  return dir
}

describe('the newest installed copy', () => {
  it('compares versions as versions, not text: 0.4.14 is newer than 0.4.9', () => {
    // Commit folders sort in no useful order; the older version is listed first and modified last.
    copy('cache/devspec/devspec/0000aaaa', { version: '0.4.9', modified: 1_800_000_000 })
    const newest = copy('cache/devspec/devspec/ffffbbbb', { version: '0.4.14', modified: 1_700_000_000 })
    assert.equal(findPluginRoot({ pluginsDir: plugins }), newest)
  })

  it('takes the most recently modified copy when two carry the same version', () => {
    copy('cache/devspec/devspec/0000aaaa', { version: '0.23.0', modified: 1_700_000_000 })
    const later = copy('cache/devspec/devspec/ffffbbbb', { version: '0.23.0', modified: 1_700_000_500 })
    assert.equal(findPluginRoot({ pluginsDir: plugins }), later)
  })

  it('falls back to the most recently modified copy when no version can be read', () => {
    copy('cache/devspec/devspec/0000aaaa', { modified: 1_700_000_000 })
    const later = copy('cache/devspec/devspec/ffffbbbb', { version: 'not a version', modified: 1_700_000_500 })
    assert.equal(findPluginRoot({ pluginsDir: plugins }), later)
  })

  it('puts a copy with a readable version ahead of one without, however recent', () => {
    const versioned = copy('cache/devspec/devspec/0000aaaa', { version: '0.1.0', modified: 1_700_000_000 })
    copy('cache/devspec/devspec/ffffbbbb', { modified: 1_900_000_000 })
    assert.equal(findPluginRoot({ pluginsDir: plugins }), versioned)
  })

  it('compares a local copy and an installed one on the same rule', () => {
    copy('cache/devspec/devspec/0000aaaa', { version: '0.22.0', modified: 1_900_000_000 })
    const local = copy('local/devspec', { version: '0.23.0', modified: 1_700_000_000 })
    assert.equal(findPluginRoot({ pluginsDir: plugins }), local)
  })

  it('gives the same answer whatever order the folders are listed in', () => {
    copy('cache/devspec/devspec/ffffbbbb', { version: '1.0.0', modified: 1_700_000_000 })
    const first = copy('cache/devspec/devspec/0000aaaa', { version: '1.0.0', modified: 1_700_000_000 })
    assert.equal(findPluginRoot({ pluginsDir: plugins }), first)
  })

  it('counts only copies of this plugin that can serve the remote skills', () => {
    const ours = copy('cache/devspec/devspec/0000aaaa', { version: '0.1.0' })
    copy('cache/devspec/devspec/1111cccc', { version: '9.0.0', helper: false })
    copy('cache/other/another-plugin/2222dddd', { name: 'another-plugin', version: '9.0.0' })
    copy('local/claude-devspec', { version: '9.0.0', manifestDir: '.claude-plugin' })
    // Cursor's marketplace index is a clone it reads plugins from, not an installed copy.
    copy('marketplaces/github.com/DevSpecAI/cursor-devspec-plugin/3333eeee', { version: '9.0.0' })
    assert.deepEqual(findPluginCopies({ pluginsDir: plugins }).map(found => found.path), [ours])
  })

  it('takes a local copy linked in, but never walks through a link', () => {
    const checkout = path.join(home, 'checkout')
    fs.mkdirSync(checkout)
    const linkedTarget = path.join(home, 'elsewhere')
    fs.mkdirSync(linkedTarget)
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    // A real checkout outside Cursor's folder, linked in as a local plugin.
    const source = copy('local/devspec', { version: '0.30.0' })
    fs.renameSync(source, path.join(checkout, 'devspec'))
    fs.symlinkSync(path.join(checkout, 'devspec'), source, kind)
    const installed = copy('cache/devspec/devspec/0000aaaa', { version: '0.29.0' })
    // A link back to the top of the tree, as Wine-style drive links make, must not loop or double count.
    fs.symlinkSync(plugins, path.join(plugins, 'cache', 'loop'), kind)
    fs.symlinkSync(linkedTarget, path.join(plugins, 'cache', 'not-a-copy'), kind)
    assert.deepEqual(findPluginCopies({ pluginsDir: plugins }).map(found => found.path), [source, installed])
  })

  it('finds nothing in an empty or missing plugins folder', () => {
    assert.equal(findPluginRoot({ pluginsDir: plugins }), null)
    assert.equal(findPluginRoot({ pluginsDir: path.join(home, 'missing') }), null)
  })
})

describe('version precedence', () => {
  const order = ['0.4.9', '0.4.14', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1+build.5', '10.0.0']
  it('follows semantic-version precedence, numbers compared as numbers', () => {
    const shuffled = [...order].reverse()
    assert.deepEqual(shuffled.sort((a, b) => compareVersions(parseVersion(a), parseVersion(b))), order)
  })
  it('ignores build metadata and refuses what is not a version', () => {
    assert.equal(compareVersions(parseVersion('1.2.3+one'), parseVersion('1.2.3+two')), 0)
    for (const bad of ['', '1.2', 'v1.2.3', '01.2.3', '1.2.3-', null, 7]) assert.equal(parseVersion(bad), null, String(bad))
  })
})

describe('the command the skills run', () => {
  const run = (finder) => spawnSync(process.execPath, [finder], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })

  it('prints the newest copy even when an older copy runs it', () => {
    const older = copy('cache/devspec/devspec/0000aaaa', { version: '0.22.0', finder: true, modified: 1_900_000_000 })
    const newest = copy('cache/devspec/devspec/ffffbbbb', { version: '0.23.1', finder: true })
    for (const from of [older, newest]) {
      const result = run(path.join(from, 'hooks', 'scripts', 'plugin-root.mjs'))
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, `${newest}\n`)
    }
    // The way the skills use it: a shell substitution, then the newest copy's helper.
    const shell = execFileSync('sh', ['-c', 'PLUGIN=$(node "$1") && printf %s "$PLUGIN/hooks/scripts/remote-control-state.mjs"', 'sh', path.join(older, 'hooks', 'scripts', 'plugin-root.mjs')], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    assert.equal(shell, path.join(newest, 'hooks', 'scripts', 'remote-control-state.mjs'))
  })

  it('says plainly that no copy was found, prints no path and fails', () => {
    // A finder outside Cursor's plugins folder, with nothing installed under it.
    const loose = path.join(home, 'loose')
    fs.mkdirSync(loose)
    for (const file of FINDER_FILES) fs.copyFileSync(path.join(here, file), path.join(loose, file))
    const result = run(path.join(loose, 'plugin-root.mjs'))
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^No installed copy of the DevSpec plugin for Cursor was found in .+\. Install it in Cursor \(or reinstall it\), then try again\.\n$/)
  })
})
