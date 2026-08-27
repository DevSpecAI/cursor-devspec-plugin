/**
 * resolveRepoFolder() must learn a repo's folder from the cwds DevSpec plugins already record,
 * rather than only guessing at conventional directory layouts.
 *
 * HOME is repointed BEFORE importing open-handler-core, because that module resolves both
 * CONNECTIONS_DIR and MAP_PATH from os.homedir() at load time (os.homedir() honours $HOME on POSIX).
 */
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const realHome = process.env.HOME
let home
let repoRoot
let core

async function git(cwd, ...args) {
  await execFileAsync('git', ['-C', cwd, ...args])
}

before(async () => {
  home = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'devspec-repo-map-'))

  // A real repo in a directory matching NONE of discoverRepoFolder's conventional roots.
  repoRoot = path.join(home, 'Software_Projects', 'Acme', 'widgets')
  await fs.mkdir(path.join(repoRoot, 'apps', 'web'), { recursive: true })
  await git(repoRoot, 'init', '--quiet')
  await git(repoRoot, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')

  // A connection state file of the shape every plugin's connect flow writes — cwd recorded
  // in a SUBDIRECTORY, to prove the repo root is what gets mapped.
  const connections = path.join(home, '.devspec', 'remote-control', 'connections')
  await fs.mkdir(connections, { recursive: true })
  await fs.writeFile(
    path.join(connections, 'aaaaaaaa-0000-4000-8000-000000000001.json'),
    JSON.stringify({ connection_id: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: path.join(repoRoot, 'apps', 'web') }),
    'utf8',
  )
  // A torn state file must not abort the scan.
  await fs.writeFile(path.join(connections, 'broken.json'), '{ not json', 'utf8')

  process.env.HOME = home
  core = await import('./open-handler-core.mjs')
})

after(async () => {
  process.env.HOME = realHome
  if (home) await fs.rm(home, { recursive: true, force: true })
})

describe('resolveRepoFolder learning from recorded connection cwds', () => {
  it('resolves a repo that no conventional-layout guess would find', async () => {
    assert.equal(await core.resolveRepoFolder('acme/widgets'), repoRoot)
  })

  it('maps the repo TOPLEVEL even though the recorded cwd was a subdirectory', async () => {
    const resolved = await core.resolveRepoFolder('acme/widgets')
    assert.equal(resolved, repoRoot)
    assert.notEqual(resolved, path.join(repoRoot, 'apps', 'web'))
  })

  it('persists what it learned so the next launch skips the scan', async () => {
    await core.resolveRepoFolder('acme/widgets')
    const map = JSON.parse(await fs.readFile(path.join(home, '.cursor', 'devspec', 'repo-folder-map.json'), 'utf8'))
    assert.equal(map['acme/widgets'], repoRoot)
  })

  it('returns null for a slug no recorded cwd matches', async () => {
    assert.equal(await core.resolveRepoFolder('acme/not-checked-out'), null)
  })

  it('re-learns when a stored mapping points at a folder that is gone', async () => {
    const mapPath = path.join(home, '.cursor', 'devspec', 'repo-folder-map.json')
    await fs.mkdir(path.dirname(mapPath), { recursive: true })
    await fs.writeFile(
      mapPath,
      JSON.stringify({ 'acme/widgets': path.join(home, 'deleted', 'widgets') }),
      'utf8',
    )

    // A stale path must not be returned, and must not wedge resolution either.
    assert.equal(await core.resolveRepoFolder('acme/widgets'), repoRoot)

    const map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
    assert.equal(map['acme/widgets'], repoRoot)
  })

  it('never returns a path for a repo that is not the one asked for', async () => {
    // A second clone of a DIFFERENT repo sharing the parent directory must not be mistaken
    // for the requested slug just because an agent also ran in it.
    const other = path.join(home, 'Software_Projects', 'Acme', 'gadgets')
    await fs.mkdir(other, { recursive: true })
    await git(other, 'init', '--quiet')
    await git(other, 'remote', 'add', 'origin', 'git@github.com:acme/gadgets.git')

    const connections = path.join(home, '.devspec', 'remote-control', 'connections')
    await fs.writeFile(
      path.join(connections, 'aaaaaaaa-0000-4000-8000-000000000002.json'),
      JSON.stringify({ connection_id: 'aaaaaaaa-0000-4000-8000-000000000002', cwd: other }),
      'utf8',
    )
    await fs.rm(path.join(home, '.cursor', 'devspec', 'repo-folder-map.json'), { force: true })

    assert.equal(await core.resolveRepoFolder('acme/gadgets'), other)
    assert.equal(await core.resolveRepoFolder('acme/widgets'), repoRoot)
  })
})
