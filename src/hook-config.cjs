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

function isOurs(command) {
  if (typeof command !== 'string') return false
  if (command.includes(MARKER)) return true
  const knownScript = /(?:run-mirror-turn|mirror-turn|trail-turn|mutation-boundary|provenance-assistance)\.mjs/i.test(command)
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
    'UserPromptSubmit',
    'stop',
    'Stop',
    ...TRAIL_EVENTS,
    ...PROVENANCE_EVENTS,
  ]) {
    hooks[event] = stripOursFromGroups(hooks[event])
  }

  const command = (mode) => `node "${stableLauncher}" ${mode} # ${MARKER}`
  const pushCursor = (event, value) => {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    list.push({ command: value })
    hooks[event] = list
  }
  const pushClaude = (event, value) => {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    list.push({ hooks: [{ type: 'command', command: value, timeout: 30 }] })
    hooks[event] = list
  }

  pushCursor('beforeSubmitPrompt', command('user_prompt'))
  pushCursor('stop', command('stop'))
  pushClaude('UserPromptSubmit', command('user_prompt'))
  pushClaude('Stop', command('stop'))

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
