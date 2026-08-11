/**
 * Ensure Cursor remote-control launches pin PLUGIN=<extension path> and embed
 * the matching skill body so the agent does not hunt Claude marketplace caches.
 *
 * Session/web launches only ship a skill prompt — they cannot know the machine's
 * extension install path. Without this pin, agents often run Claude marketplace
 * poller scripts (`AGENT_NAME = 'Claude Code'`), which overwrite a correctly
 * registered Cursor connection's agent_name on every heartbeat. Without the
 * embedded skill body, agents still spend a minute globbing for SKILL.md.
 *
 * Command-palette paste already injects PLUGIN= + skill via skill-paste-prompt.ts;
 * this module is the equivalent for protocol-handler / CLI / IDE deeplink launches.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareSemverTuples,
  parseExtensionVersion,
} from '../hooks/scripts/run-mirror-turn.mjs'

const EXTENSION_DIR_PREFIX = 'devspecai.devspec-autopilot-'

const REMOTE_SKILL_IDS = /** @type {const} */ (['devspec.remote', 'devspec.remote-stop'])

/** @param {string} prompt */
export function promptNeedsRemotePluginPin(prompt) {
  const p = String(prompt ?? '').toLowerCase()
  return (
    p.includes('devspec.remote') ||
    p.includes('devspec.remote-stop') ||
    p.includes('register_connection') ||
    p.includes('attach_connection')
  )
}

/** @param {string} prompt */
export function promptAlreadyHasPluginPin(prompt) {
  return /^\s*PLUGIN=/m.test(String(prompt ?? ''))
}

/**
 * Parse `devspec.remote` / `devspec.remote-stop` from a web skill header.
 * @param {string} prompt
 * @returns {'devspec.remote' | 'devspec.remote-stop' | null}
 */
export function parseRemoteSkillIdFromPrompt(prompt) {
  const m = String(prompt ?? '').match(/`?(devspec\.remote(?:-stop)?)`?/)
  if (!m) return null
  const id = m[1]
  return REMOTE_SKILL_IDS.includes(/** @type {*} */ (id)) ? /** @type {*} */ (id) : null
}

/**
 * True when the prompt already carries the skill markdown (palette paste or a
 * prior expand). Avoids double-embedding on re-entry.
 * @param {string} prompt
 * @param {string} skillId
 */
export function promptAlreadyHasSkillBody(prompt, skillId) {
  const p = String(prompt ?? '')
  if (skillId === 'devspec.remote-stop') {
    return (
      /#\s*DevSpec Remote Control\s*[—-]\s*Stop/i.test(p) ||
      (/devspec\.remote-stop/i.test(p) && /end_reason/i.test(p))
    )
  }
  return (
    /#\s*DevSpec Remote Control\b/i.test(p) &&
    /register_connection/i.test(p) &&
    /Plugin root/i.test(p)
  )
}

/**
 * Extension root when this module is running from an installed VSIX tree
 * (`…/extensions/devspecai.devspec-autopilot-x.y.z/scripts/pin-remote-plugin.mjs`).
 * @param {string} [moduleUrl] `import.meta.url` of a script under `scripts/`
 * @returns {string | null}
 */
export function resolveExtensionPathFromScriptsDir(moduleUrl = import.meta.url) {
  try {
    const scriptsDir = path.dirname(fileURLToPath(moduleUrl))
    const root = path.resolve(scriptsDir, '..')
    const stateScript = path.join(root, 'hooks', 'scripts', 'remote-control-state.mjs')
    if (!fs.existsSync(stateScript)) return null
    return root
  } catch {
    return null
  }
}

/**
 * Newest installed Cursor DevSpec extension under ~/.cursor/extensions.
 * @param {string} [homeDir]
 * @returns {string | null}
 */
export function resolveCursorDevspecExtensionPath(homeDir = os.homedir()) {
  const extensionsRoot = path.join(homeDir, '.cursor', 'extensions')
  let entries
  try {
    entries = fs.readdirSync(extensionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  // Semver order — NOT lexicographic `.sort()`. Lex puts 0.4.9 above 0.4.14
  // (string '9' > '1'), which pinned every Agents launch to the stale VSIX.
  const candidates = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(EXTENSION_DIR_PREFIX))
    .map((e) => ({
      name: e.name,
      version: parseExtensionVersion(e.name),
      full: path.join(extensionsRoot, e.name),
    }))
    .filter((c) =>
      fs.existsSync(path.join(c.full, 'hooks', 'scripts', 'remote-control-state.mjs')),
    )
    .sort((a, b) => compareSemverTuples(b.version, a.version))
  return candidates[0]?.full ?? null
}

/**
 * Prefer the running extension tree; fall back to newest under ~/.cursor/extensions.
 * @param {{ homeDir?: string, extensionPath?: string | null, moduleUrl?: string }} [opts]
 * @returns {string | null}
 */
export function resolveRemotePluginExtensionPath(opts = {}) {
  if (opts.extensionPath !== undefined) return opts.extensionPath
  // Explicit homeDir (tests / alternate profiles) wins over the running scripts tree.
  if (opts.homeDir !== undefined) {
    return resolveCursorDevspecExtensionPath(opts.homeDir)
  }
  return (
    resolveExtensionPathFromScriptsDir(opts.moduleUrl) ??
    resolveCursorDevspecExtensionPath()
  )
}

/**
 * @param {string} extensionPath
 * @returns {string}
 */
export function buildPluginPinBlock(extensionPath) {
  return [
    `PLUGIN=${extensionPath}`,
    'Use this PLUGIN path for all remote-control scripts (quote it in shell commands).',
    'Do NOT search ~/.claude/plugins or Claude marketplace caches for remote-control scripts.',
    'Do NOT glob for the skill — the skill body is included below when available.',
  ].join('\n')
}

/**
 * @param {string} extensionPath
 * @param {string} skillId
 * @returns {string | null}
 */
export function readExtensionSkillBody(extensionPath, skillId) {
  const skillPath = path.join(extensionPath, 'skills', skillId, 'SKILL.md')
  try {
    const raw = fs.readFileSync(skillPath, 'utf8')
    return raw.trim() || null
  } catch {
    return null
  }
}

/**
 * Prepend PLUGIN= when the prompt is a remote-control connect and the pin is missing.
 * @param {string | null | undefined} promptText
 * @param {{ homeDir?: string, extensionPath?: string | null, moduleUrl?: string }} [opts]
 * @returns {string | null}
 */
export function pinRemotePluginInPrompt(promptText, opts = {}) {
  if (promptText == null) return null
  const trimmed = String(promptText).trim()
  if (!trimmed) return promptText
  if (!promptNeedsRemotePluginPin(trimmed)) return promptText
  if (promptAlreadyHasPluginPin(trimmed)) return promptText

  const extensionPath = resolveRemotePluginExtensionPath(opts)
  if (!extensionPath) return promptText

  return `${buildPluginPinBlock(extensionPath)}\n\n${trimmed}`
}

/**
 * Pin PLUGIN= and embed the Cursor extension skill body for cold CLI/IDE launches
 * so the agent never hunts ~/.claude marketplace skill files (item 57d8b288).
 * @param {string | null | undefined} promptText
 * @param {{ homeDir?: string, extensionPath?: string | null, moduleUrl?: string }} [opts]
 * @returns {string | null}
 */
export function expandRemoteControlLaunchPrompt(promptText, opts = {}) {
  if (promptText == null) return null
  const pinned = pinRemotePluginInPrompt(promptText, opts)
  if (pinned == null) return null

  const skillId = parseRemoteSkillIdFromPrompt(pinned)
  if (!skillId) return pinned
  if (promptAlreadyHasSkillBody(pinned, skillId)) return pinned

  const extensionPath =
    opts.extensionPath !== undefined
      ? opts.extensionPath
      : resolveRemotePluginExtensionPath(opts) ??
        (promptAlreadyHasPluginPin(pinned)
          ? (pinned.match(/^\s*PLUGIN=(.+)$/m)?.[1]?.trim() ?? null)
          : null)
  if (!extensionPath) return pinned

  const body = readExtensionSkillBody(extensionPath, skillId)
  if (!body) return pinned

  return `${pinned}\n\n---\n\n${body}\n`
}
