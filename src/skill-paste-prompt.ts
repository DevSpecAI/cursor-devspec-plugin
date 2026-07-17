/**
 * Build the Agent paste prompt for a DevSpec skill.
 * For remote-control skills, inject the absolute extension path as PLUGIN=…
 * so the model never hunts Claude marketplace caches.
 */

const SKILLS_NEEDING_PLUGIN_ROOT: ReadonlySet<string> = new Set([
  'devspec.remote',
  'devspec.remote-stop',
])

export function skillNeedsPluginRoot(skillId: string): boolean {
  return SKILLS_NEEDING_PLUGIN_ROOT.has(skillId)
}

export function buildSkillPastePrompt(
  skillId: string,
  skillBody: string,
  userInput: string | undefined,
  extensionPath: string,
): string {
  const header = userInput
    ? `Run the \`${skillId}\` skill with this input: ${userInput}`
    : `Run the \`${skillId}\` skill.`

  if (!skillNeedsPluginRoot(skillId)) {
    return `${header}\n\n---\n\n${skillBody}`
  }

  const pluginBlock = [
    `PLUGIN=${extensionPath}`,
    'Use this PLUGIN path for all remote-control scripts (quote it in shell commands).',
    'Do NOT search ~/.claude/plugins or Claude marketplace caches for remote-control scripts.',
  ].join('\n')

  return `${header}\n\n${pluginBlock}\n\n---\n\n${skillBody}`
}
