/**
 * Installing the launcher from a plugin, safely, on every start-up.
 *
 * Up to seven plugins can carry this launcher, and each one calls ensure() when its
 * own code first runs. Without a version marker that is last-writer-wins: a plugin
 * pinned to an older copy would overwrite a newer launcher every time it started.
 * So the installed copy records its version and we install only when ours is
 * strictly newer (ADR 8ced3e43, D2).
 *
 * This runs on every session start for hook-based hosts, so the common path — right
 * version already there — must be one small file read and nothing else.
 *
 * Everything here fails soft. A launcher that cannot install is a rocket button that
 * does nothing; a launcher that throws inside a plugin's start-up hook breaks the
 * agent itself. The second is far worse, so every failure returns a reason instead.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LAUNCHER_HOME = path.join(os.homedir(), '.devspec', 'launcher')
export const VERSION_MARKER = '.launcher-version'

/**
 * Compare two dotted numeric versions. Returns >0 when a is newer, 0 when equal,
 * <0 when older. Anything unparseable sorts as oldest, so a corrupt marker is
 * replaced rather than treated as newer than everything.
 */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? '')
      .trim()
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10)
        return Number.isFinite(n) ? n : -1
      })
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/** The version currently installed, or null when nothing is installed or the marker is unreadable. */
export function readInstalledVersion(home = LAUNCHER_HOME, io = fs) {
  try {
    const raw = io.readFileSync(path.join(home, VERSION_MARKER), 'utf8')
    const parsed = JSON.parse(raw)
    const v = typeof parsed?.version === 'string' ? parsed.version.trim() : ''
    return v || null
  } catch {
    return null
  }
}

/**
 * Install this plugin's bundled launcher into the machine-level home when it is
 * strictly newer than what is there.
 *
 * `outcome` is one of:
 *   installed   — nothing was there, or ours is newer
 *   current     — the same version is already installed
 *   kept_newer  — a newer launcher is installed and we left it alone
 *   failed      — could not read or write; `reason` says why
 */
export function ensureLauncherInstalled({ sourceDir, version, home = LAUNCHER_HOME, io = fs } = {}) {
  if (!sourceDir || !version) {
    return { ok: false, outcome: 'failed', reason: 'sourceDir and version are required' }
  }

  const installed = readInstalledVersion(home, io)
  if (installed !== null) {
    const diff = compareVersions(version, installed)
    if (diff === 0) return { ok: true, outcome: 'current', version: installed }
    if (diff < 0) return { ok: true, outcome: 'kept_newer', version: installed, offered: version }
  }

  try {
    io.mkdirSync(home, { recursive: true })
    for (const entry of io.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      io.copyFileSync(path.join(sourceDir, entry.name), path.join(home, entry.name))
    }
    io.writeFileSync(
      path.join(home, VERSION_MARKER),
      `${JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2)}\n`,
    )
    return { ok: true, outcome: 'installed', version, replaced: installed }
  } catch (err) {
    // A read-only home, a sandbox, a race with another plugin doing the same thing.
    // None of these should take the agent down with them.
    return { ok: false, outcome: 'failed', reason: err?.message || String(err) }
  }
}
