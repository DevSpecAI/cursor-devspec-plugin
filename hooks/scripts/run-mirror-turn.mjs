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
 *   node "%USERPROFILE%\.cursor\devspec\hooks\run-mirror-turn.mjs" postToolUse
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXT_PREFIX = 'devspecai.devspec-autopilot-'

const PROVENANCE_MODE_PREFIX = 'provenance-'
export const PROVENANCE_CHILD_TIMEOUT_MS = 10_000

export function provenanceChildTimeoutMs(env = process.env) {
  const requested = Number(env.DEVSPEC_CURSOR_PROVENANCE_CHILD_TIMEOUT_MS)
  return Number.isFinite(requested) && requested >= 50
    ? Math.min(requested, PROVENANCE_CHILD_TIMEOUT_MS)
    : PROVENANCE_CHILD_TIMEOUT_MS
}

const TRAIL_MODES = new Set([
  'seed',
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'beforeShellExecution',
  'afterMCPExecution',
  'beforeMCPExecution',
  'afterFileEdit',
  'afterAgentThought',
])

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
 * Pick the newest installed DevSpec Cursor extension that still has the script.
 * @param {string} scriptName relative under hooks/scripts/
 * @param {string} [home]
 * @param {{ readdirSync?: typeof fs.readdirSync, existsSync?: typeof fs.existsSync }} [io]
 * @returns {string | null} absolute path to the script
 */
export function resolveInstalledHookScript(scriptName, home = os.homedir(), io = {}) {
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
      script: path.join(extRoot, name, 'hooks', 'scripts', scriptName),
    }))
    .filter((c) => existsSync(c.script))
    .sort((a, b) => compareSemverTuples(b.version, a.version))
  return candidates[0]?.script ?? null
}

/** @deprecated prefer resolveInstalledHookScript('mirror-turn.mjs') */
export function resolveInstalledMirrorTurn(home = os.homedir(), io = {}) {
  return resolveInstalledHookScript('mirror-turn.mjs', home, io)
}

/** Stable install path refreshed on extension activate / open-handler --install. */
export function stableMirrorTurnPath(home = os.homedir()) {
  return path.join(home, '.cursor', 'devspec', 'hooks', 'run-mirror-turn.mjs')
}

export function resolveHookInvocation(modeValue) {
  const modeArg = String(modeValue || 'stop')
  const provenanceMode = modeArg.startsWith(PROVENANCE_MODE_PREFIX)
    ? modeArg.slice(PROVENANCE_MODE_PREFIX.length)
    : null
  const isProvenance = Boolean(provenanceMode && ['preToolUse', 'postToolUse', 'afterMCPExecution'].includes(provenanceMode))
  const isTrail = TRAIL_MODES.has(modeArg)
  return {
    mode: isProvenance ? provenanceMode : isTrail ? modeArg : modeArg === 'user_prompt' ? 'user_prompt' : 'stop',
    scriptName: isProvenance
      ? 'provenance-assistance.mjs'
      : isTrail
        ? 'trail-turn.mjs'
        : 'mirror-turn.mjs',
  }
}

export function hookChildExitCode(scriptName, result) {
  if (scriptName === 'provenance-assistance.mjs') return 0
  return typeof result?.status === 'number' ? result.status : 1
}

function main() {
  const { mode, scriptName } = resolveHookInvocation(process.argv[2])
  const target = resolveInstalledHookScript(scriptName)
  if (!target) {
    process.stderr.write(
      `[devspec-remote] no installed ${scriptName} under ~/.cursor/extensions/devspecai.devspec-autopilot-*\n`,
    )
    process.exit(0)
  }
  const isProvenance = scriptName === 'provenance-assistance.mjs'
  const result = spawnSync(process.execPath, [target, mode], {
    stdio: isProvenance ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: isProvenance ? 'utf8' : undefined,
    timeout: isProvenance ? provenanceChildTimeoutMs(process.env) : undefined,
    killSignal: isProvenance ? 'SIGKILL' : undefined,
    windowsHide: true,
    env: process.env,
  })
  if (isProvenance) {
    if (result.stderr) process.stderr.write(result.stderr)
    if (!result.error && result.status === 0) {
      if (result.stdout) process.stdout.write(result.stdout)
    } else {
      process.stderr.write(`[devspec-provenance] launcher failed open: ${result.error?.message || `child exited ${result.status ?? 'without status'}`}\n`)
    }
  }
  process.exit(hookChildExitCode(scriptName, result))
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
