/**
 * Space-free Windows pin for Connect wait-first argv (items dc3fb0f5, 6de4b055).
 *
 * Cursor's TUI wraps quoted paths on the space in `C:\Users\Brandon Young\...`
 * and the model drops the quotes, so `node <wait-script>` must be one unquoted
 * token. Junction the resolved plugin root under %ProgramData%\DevSpec\ — a
 * path with no whitespace — and keep PLUGIN= on the real (possibly spaced) tree.
 *
 * Do not share one retargetable `cursor-plugin` junction: a leftover VSIX pin
 * made `spaceSafePluginRoot` fail-open to the spaced worktree. Each root gets
 * `cursor-plugin-<hash>` beside that legacy name. Never recursive-delete through
 * a junction (that walks into the VSIX).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function pathHasWhitespace(p) {
  return /[\s]/.test(String(p ?? ''))
}

/** Legacy single-pin path. Stale junctions here are left alone (item 6de4b055). */
export function win32SpaceSafePluginPin(programData = process.env.ProgramData) {
  return path.join(String(programData || 'C:\\ProgramData'), 'DevSpec', 'cursor-plugin')
}

export function pluginRootPinHash(pluginRoot) {
  return createHash('sha256')
    .update(path.resolve(String(pluginRoot ?? '')).toLowerCase())
    .digest('hex')
    .slice(0, 12)
}

/**
 * Space-free pin destination for this plugin root.
 * Tests may pass `pinRoot` as the exact destination (no hash).
 * Production uses a hashed sibling of the legacy `cursor-plugin` junction.
 *
 * @param {string} pluginRoot
 * @param {{ pinRoot?: string, programData?: string }} [opts]
 * @returns {string}
 */
export function win32SpaceSafePluginPinForRoot(pluginRoot, opts = {}) {
  if (opts.pinRoot) return path.resolve(String(opts.pinRoot))
  const legacy = win32SpaceSafePluginPin(opts.programData)
  return path.join(path.dirname(legacy), `cursor-plugin-${pluginRootPinHash(pluginRoot)}`)
}

function sameWinPath(a, b) {
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
}

/**
 * Remove the pin node itself (junction/symlink). Never recursive-delete through it.
 * @param {string} pin
 * @param {{ unlinkSync?: (p: string) => void, rmdirSync?: (p: string) => void }} ops
 */
export function unlinkPinNode(pin, ops = {}) {
  const unlink = ops.unlinkSync ?? ((p) => fs.unlinkSync(p))
  const rmdir = ops.rmdirSync ?? ((p) => fs.rmdirSync(p))
  try {
    unlink(pin)
  } catch {
    rmdir(pin)
  }
}

/**
 * When pluginRoot contains whitespace, junction it to a space-free pin so the
 * wait-first argv path is one unquoted token. POSIX / space-free roots unchanged.
 *
 * @param {string} pluginRoot
 * @param {{
 *   platform?: NodeJS.Platform,
 *   pinRoot?: string,
 *   programData?: string,
 *   mkdirSync?: (d: string) => void,
 *   existsSync?: (p: string) => boolean,
 *   lstatSync?: (p: string) => { isSymbolicLink?: () => boolean, isDirectory?: () => boolean },
 *   unlinkSync?: (p: string) => void,
 *   rmdirSync?: (p: string) => void,
 *   symlinkSync?: (target: string, dest: string) => void,
 *   readlinkSync?: (p: string) => string,
 * }} [opts]
 * @returns {string}
 */
export function spaceSafePluginRoot(pluginRoot, opts = {}) {
  const root = path.resolve(String(pluginRoot ?? ''))
  if (!root || !pathHasWhitespace(root)) return root
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return root
  const pin = win32SpaceSafePluginPinForRoot(root, opts)
  if (pathHasWhitespace(pin)) {
    throw new Error(`spaceSafePluginRoot: pin path still has whitespace: ${pin}`)
  }
  const mkdir = opts.mkdirSync ?? ((d) => fs.mkdirSync(d, { recursive: true }))
  const exists = opts.existsSync ?? ((p) => fs.existsSync(p))
  const lstat = opts.lstatSync ?? ((p) => fs.lstatSync(p))
  const symlink = opts.symlinkSync ?? ((target, dest) => fs.symlinkSync(target, dest, 'junction'))
  const readlink = opts.readlinkSync ?? ((p) => fs.readlinkSync(p))
  try {
    mkdir(path.dirname(pin))
    if (exists(pin)) {
      let current = ''
      try {
        current = path.resolve(String(readlink(pin)))
      } catch {
        current = ''
      }
      if (current && sameWinPath(current, root)) return pin
      const st = lstat(pin)
      if (!st.isSymbolicLink?.()) {
        throw new Error(`spaceSafePluginRoot: pin exists and is not a junction: ${pin}`)
      }
      unlinkPinNode(pin, opts)
    }
    symlink(root, pin)
    return pin
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`spaceSafePluginRoot: cannot pin spaced plugin root (${root}): ${detail}`)
  }
}

/** `--install` / Connect: same as spaceSafePluginRoot, named for the install hook. */
export function ensureSpaceSafePluginPin(pluginRoot, opts = {}) {
  return spaceSafePluginRoot(pluginRoot, opts)
}
