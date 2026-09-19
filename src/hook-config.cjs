const MARKER = 'devspec-remote-mirror'

const TRAIL_EVENTS = [
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'beforeShellExecution',
  'afterMCPExecution',
  'beforeMCPExecution',
  'afterFileEdit',
  'afterAgentThought',
]

const PROVENANCE_EVENTS = [
  'preToolUse',
  'postToolUse',
  'afterMCPExecution',
]

// Claude Code event names we used to write into ~/.cursor/hooks.json. Cursor
// does not know them, and one unknown key invalidates the entire file — so we
// no longer emit them, and we clean them out of files that already have them.
const LEGACY_CLAUDE_EVENTS = ['UserPromptSubmit', 'Stop']

function isOurs(command) {
  if (typeof command !== 'string') return false
  if (command.includes(MARKER)) return true
  const knownScript = /(?:run-mirror-turn|mirror-turn|trail-turn|mutation-boundary|provenance-assistance|mark-explicit-reply)\.mjs/i.test(command)
  const devspecPath = /devspecai\.devspec-autopilot|[\\/]\.cursor[\\/]devspec[\\/]hooks|\$\{CLAUDE_PLUGIN_ROOT\}/i.test(command)
  return knownScript && devspecPath
}

function stripOursFromGroups(groups) {
  if (!Array.isArray(groups)) return []
  return groups
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      if (Array.isArray(entry.hooks)) {
        const hooks = entry.hooks.filter((hook) => !isOurs(hook?.command))
        return hooks.length ? { ...entry, hooks } : null
      }
      return isOurs(entry.command) ? null : entry
    })
    .filter(Boolean)
}

/**
 * Merge the DevSpec Cursor hook fragment without replacing third-party hooks.
 * Re-running this function is idempotent, including upgrades from legacy paths.
 */
function mergeCursorHookConfig(input, stableLauncher) {
  const file = input && typeof input === 'object' && !Array.isArray(input)
    ? structuredClone(input)
    : {}
  if (file.version === undefined) file.version = 1
  const hooks = file.hooks && typeof file.hooks === 'object' && !Array.isArray(file.hooks)
    ? file.hooks
    : {}

  for (const event of [
    'beforeSubmitPrompt',
    ...LEGACY_CLAUDE_EVENTS,
    'stop',
    ...TRAIL_EVENTS,
    ...PROVENANCE_EVENTS,
  ]) {
    hooks[event] = stripOursFromGroups(hooks[event])
  }

  // Cursor rejects the WHOLE hooks.json when it contains an event name it does
  // not know, so a leftover `"Stop": []` is just as fatal as a populated one —
  // it silently disables every other hook in the file (item 1b021c9e). Drop any
  // key we emptied. A key still holding someone else's entries is left alone:
  // deleting a third party's hooks is not ours to do.
  for (const event of LEGACY_CLAUDE_EVENTS) {
    if (Array.isArray(hooks[event]) && hooks[event].length === 0) delete hooks[event]
  }

  const command = (mode) => `node "${stableLauncher}" ${mode} # ${MARKER}`
  const pushCursor = (event, value) => {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    list.push({ command: value })
    hooks[event] = list
  }

  // Cursor event names only. We used to ALSO write Claude Code's `Stop` /
  // `UserPromptSubmit` as a compatibility belt-and-braces; that is what broke
  // the file, because Cursor validates the whole config and bails on an
  // unrecognised key. Claude-format hooks are read from Claude's own
  // settings.json, never from a key inside ~/.cursor/hooks.json.
  pushCursor('beforeSubmitPrompt', command('user_prompt'))
  pushCursor('stop', command('stop'))

  for (const event of PROVENANCE_EVENTS) {
    pushCursor(event, command(`provenance-${event}`))
  }
  for (const event of TRAIL_EVENTS) pushCursor(event, command(event))

  file.hooks = hooks
  return file
}

module.exports = {
  PROVENANCE_EVENTS,
  MARKER,
  TRAIL_EVENTS,
  mergeCursorHookConfig,
}
