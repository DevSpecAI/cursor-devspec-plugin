import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  buildExternalDirectoryAllowFromMappedFolders,
  commonAncestorDirectory,
  isUnsafeAncestor,
  mappedFoldersFromRepoMap,
  mergeOpenCodePermissionEnv,
  pathPatternVariants,
} from './opencode-mapped-permissions.mjs'

/** @param {string} p */
function abs(p) {
  return path.resolve(p)
}

/** @param {Record<string, string>} rules @param {string} dir */
function hasAllow(rules, dir) {
  return pathPatternVariants(dir).some(
    (variant) => rules[`${variant}/**`] === 'allow' && rules[`${variant}/*`] === 'allow',
  )
}

describe('mappedFoldersFromRepoMap', () => {
  it('reads string folder values from the map object', () => {
    assert.deepEqual(
      mappedFoldersFromRepoMap({
        'Org/A': '/home/u/work/a',
        'Org/B': '/home/u/work/b',
        empty: '',
        num: 1,
      }),
      ['/home/u/work/a', '/home/u/work/b'],
    )
  })
})

describe('commonAncestorDirectory', () => {
  it('finds a shared parent for sibling checkouts', () => {
    const ancestor = commonAncestorDirectory([abs('/Users/dev/Repos/App'), abs('/Users/dev/Repos/Plugin')])
    assert.equal(ancestor, abs('/Users/dev/Repos'))
  })

  it('returns null when the only shared ancestor is unsafe (drive/root)', () => {
    // On Windows these share C:\; on POSIX they share /. Both are unsafe.
    assert.equal(commonAncestorDirectory([abs('/Users/a/one'), abs('/tmp/two')]), null)
  })
})

describe('isUnsafeAncestor', () => {
  it('rejects the filesystem root / drive root', () => {
    assert.equal(isUnsafeAncestor(path.parse(process.cwd()).root), true)
  })
})

describe('buildExternalDirectoryAllowFromMappedFolders', () => {
  it('returns no rules for a single mapped folder', () => {
    const launch = abs('/Users/dev/Repos/App')
    const rules = buildExternalDirectoryAllowFromMappedFolders({
      launchFolder: launch,
      mappedFolders: [launch],
    })
    assert.deepEqual(rules, {})
  })

  it('allows sibling mapped folders and their common parent', () => {
    const launch = abs('/Users/dev/Repos/App')
    const sibling = abs('/Users/dev/Repos/Plugin')
    const parent = abs('/Users/dev/Repos')
    const rules = buildExternalDirectoryAllowFromMappedFolders({
      launchFolder: launch,
      mappedFolders: [launch, sibling],
    })
    assert.equal(hasAllow(rules, sibling), true)
    assert.equal(hasAllow(rules, parent), true)
    // Must not blank-check the launch folder itself as external.
    assert.equal(hasAllow(rules, launch), false)
  })

  it('allows only the other mapped folders when they do not share a safe parent', () => {
    const launch = abs('/Users/dev/a/App')
    // Pick a path that will not share a safe ancestor with launch on this OS.
    const other =
      process.platform === 'win32'
        ? 'D:\\other\\Plugin'
        : '/var/other/Plugin'
    const rules = buildExternalDirectoryAllowFromMappedFolders({
      launchFolder: launch,
      mappedFolders: [launch, other],
    })
    assert.equal(hasAllow(rules, other), true)
    assert.equal(hasAllow(rules, abs('/Users/dev')), false)
    assert.equal(Object.keys(rules).some((k) => k === '/**' || k === '\\**'), false)
  })

  it('treats Windows drive-letter case as the same folder', { skip: process.platform !== 'win32' }, () => {
    const launch = 'C:\\Users\\dev\\Repos\\App'
    const mappedLaunch = 'c:\\Users\\dev\\Repos\\App'
    const sibling = 'c:\\Users\\dev\\Repos\\Plugin'
    const parent = 'c:\\Users\\dev\\Repos'
    const rules = buildExternalDirectoryAllowFromMappedFolders({
      launchFolder: launch,
      mappedFolders: [mappedLaunch, sibling],
    })
    assert.equal(hasAllow(rules, sibling), true)
    assert.equal(hasAllow(rules, parent), true)
    assert.equal(hasAllow(rules, mappedLaunch), false)
  })
})

describe('mergeOpenCodePermissionEnv', () => {
  it('writes derived external_directory when env is empty', () => {
    const json = mergeOpenCodePermissionEnv(undefined, {
      '/Users/dev/Repos/Plugin/**': 'allow',
    })
    assert.deepEqual(JSON.parse(json), {
      external_directory: { '/Users/dev/Repos/Plugin/**': 'allow' },
    })
  })

  it('preserves existing path rules and fills missing ones', () => {
    const json = mergeOpenCodePermissionEnv(
      JSON.stringify({
        bash: 'allow',
        external_directory: { '/tmp/keep/**': 'deny' },
      }),
      { '/Users/dev/Repos/Plugin/**': 'allow', '/tmp/keep/**': 'allow' },
    )
    const parsed = JSON.parse(json)
    assert.equal(parsed.bash, 'allow')
    assert.equal(parsed.external_directory['/tmp/keep/**'], 'deny')
    assert.equal(parsed.external_directory['/Users/dev/Repos/Plugin/**'], 'allow')
  })

  it('leaves a global string external_directory alone', () => {
    const existing = JSON.stringify({ external_directory: 'deny' })
    assert.equal(
      mergeOpenCodePermissionEnv(existing, { '/Users/dev/Repos/Plugin/**': 'allow' }),
      existing,
    )
  })
})
