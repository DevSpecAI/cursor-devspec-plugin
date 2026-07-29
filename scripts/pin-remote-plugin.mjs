/**
 * Ensure Cursor remote-control launches pin PLUGIN=<extension path>.
 *
 * Session/web launches only ship a skill prompt — they cannot know the machine's
 * extension install path. Without this pin, agents often run Claude marketplace
 * poller scripts (`AGENT_NAME = 'Claude Code'`), which overwrite a correctly
 * registered Cursor connection's agent_name on every heartbeat.
 *
 * Command-palette paste already injects PLUGIN= via skill-paste-prompt.ts; this
 * module is the equivalent for protocol-handler / CLI / IDE deeplink launches.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXTENSION_DIR_PREFIX = 'devspecai.devspec-autopilot-'

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
  const matches = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(EXTENSION_DIR_PREFIX))
    .map((e) => e.name)
    .sort()
  const newest = matches.at(-1)
  if (!newest) return null
  const full = path.join(extensionsRoot, newest)
  const stateScript = path.join(full, 'hooks', 'scripts', 'remote-control-state.mjs')
  if (!fs.existsSync(stateScript)) return null
  return full
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
  ].join('\n')
}

/**
 * Prepend PLUGIN= when the prompt is a remote-control connect and the pin is missing.
 * @param {string | null | undefined} promptText
 * @param {{ homeDir?: string, extensionPath?: string | null }} [opts]
 * @returns {string | null}
 */
export function pinRemotePluginInPrompt(promptText, opts = {}) {
  if (promptText == null) return null
  const trimmed = String(promptText).trim()
  if (!trimmed) return promptText
  if (!promptNeedsRemotePluginPin(trimmed)) return promptText
  if (promptAlreadyHasPluginPin(trimmed)) return promptText

  const extensionPath =
    opts.extensionPath !== undefined
      ? opts.extensionPath
      : resolveCursorDevspecExtensionPath(opts.homeDir)
  if (!extensionPath) return promptText

  return `${buildPluginPinBlock(extensionPath)}\n\n${trimmed}`
}
