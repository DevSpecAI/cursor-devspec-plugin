#!/usr/bin/env node
/**
 * Version-stable entry for Cursor Agent hooks (item 2097651e / fe456bf9).
 *
 * ~/.cursor/hooks.json must NOT pin a versioned extension path — Cursor deletes
 * the old VSIX directory on bump and the Stop/user_prompt hooks go silent.
 * This launcher lives at a stable path (~/.cursor/devspec/hooks/run-mirror-turn.mjs)
 * and resolves the newest installed `devspecai.devspec-autopilot-*` copy each run.
 *
 * Usage (hooks.json):
 *   node "%USERPROFILE%\.cursor\devspec\hooks\run-mirror-turn.mjs" stop
 *   node "%USERPROFILE%\.cursor\devspec\hooks\run-mirror-turn.mjs" user_prompt
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXT_PREFIX = 'devspecai.devspec-autopilot-'

/**
 * Parse `devspecai.devspec-autopilot-0.4.7` → [0,4,7] (non-numeric tails → 0).
 * @param {string} dirName
 * @returns {number[]}
 */
export function parseExtensionVersion(dirName) {
  const raw = String(dirName || '')
  const m = raw.match(/devspecai\.devspec-autopilot-(.+)$/i)
  if (!m) return []
  return m[1].split(/[.+-]/).map((p) => {
    const n = Number.parseInt(p, 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** @param {number[]} a @param {number[]} b */
export function compareSemverTuples(a, b) {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

/**
 * Pick the newest installed DevSpec Cursor extension that still has mirror-turn.mjs.
 * @param {string} [home]
 * @param {{ readdirSync?: typeof fs.readdirSync, existsSync?: typeof fs.existsSync }} [io]
 * @returns {string | null} absolute path to mirror-turn.mjs
 */
export function resolveInstalledMirrorTurn(home = os.homedir(), io = {}) {
  const readdirSync = io.readdirSync || fs.readdirSync
  const existsSync = io.existsSync || fs.existsSync
  const extRoot = path.join(home, '.cursor', 'extensions')
  let names = []
  try {
    names = readdirSync(extRoot)
  } catch {
    return null
  }
  const candidates = names
    .filter((n) => String(n).toLowerCase().startsWith(EXT_PREFIX))
    .map((name) => ({
      name,
      version: parseExtensionVersion(name),
      script: path.join(extRoot, name, 'hooks', 'scripts', 'mirror-turn.mjs'),
    }))
    .filter((c) => existsSync(c.script))
    .sort((a, b) => compareSemverTuples(b.version, a.version))
  return candidates[0]?.script ?? null
}

/** Stable install path refreshed on extension activate / open-handler --install. */
export function stableMirrorTurnPath(home = os.homedir()) {
  return path.join(home, '.cursor', 'devspec', 'hooks', 'run-mirror-turn.mjs')
}

function main() {
  const mode = process.argv[2] === 'user_prompt' ? 'user_prompt' : 'stop'
  const target = resolveInstalledMirrorTurn()
  if (!target) {
    process.stderr.write(
      '[devspec-remote] no installed mirror-turn.mjs under ~/.cursor/extensions/devspecai.devspec-autopilot-*\n',
    )
    process.exit(0)
  }
  const result = spawnSync(process.execPath, [target, mode], {
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  })
  process.exit(typeof result.status === 'number' ? result.status : 1)
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
