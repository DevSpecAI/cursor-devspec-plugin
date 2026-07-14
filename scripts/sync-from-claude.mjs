#!/usr/bin/env node
/**
 * Sync Cursor plugin skills from Claude Code plugin commands.
 * Source of truth: ../claude-code-devspec-autopilot/commands/*.md
 * Special case: autopilot.process is assembled from autopilot.start + autopilot SKILL.md
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CURSOR_ROOT = join(__dirname, '..')
// Locate the Claude Code plugin (the source of truth). Prefer an explicit env
// override, then known checkout layouts: the Claude plugin as a sibling of this
// repo, or under a separate "DevSpec Autopilot Plugin" parent. Fail with a clear
// message rather than an opaque ENOENT when none is found.
const CLAUDE_ROOT = (() => {
  const candidates = [
    process.env.DEVSPEC_CLAUDE_PLUGIN_ROOT,
    join(CURSOR_ROOT, '..', 'claude-code-devspec-autopilot'),
    join(CURSOR_ROOT, '..', '..', 'DevSpec Autopilot Plugin', 'claude-code-devspec-autopilot'),
  ].filter(Boolean)
  const found = candidates.find((c) => existsSync(join(c, 'commands')))
  if (found) return found
  console.error(
    '✗ Could not locate the Claude Code plugin (source of truth). Tried:\n' +
      candidates.map((c) => '  - ' + c).join('\n') +
      '\nSet DEVSPEC_CLAUDE_PLUGIN_ROOT to its path and re-run.',
  )
  process.exit(1)
})()
const SKILLS_DIR = join(CURSOR_ROOT, 'skills')

const DIRECT_MAP = {
  'devspec.work': 'devspec.work.md',
  'devspec.brainstorm': 'devspec.brainstorm.md',
  'devspec.verify-connection': 'devspec.verify-connection.md',
  'devspec.create': 'devspec.create.md',
  'devspec.session-brainstorm': 'devspec.session-brainstorm.md',
  'devspec.done': 'devspec.done.md',
  'devspec.help': 'devspec.help.md',
  'devspec.link': 'devspec.link.md',
  'devspec.commit': 'devspec.commit.md',
  'autopilot.status': 'autopilot.status.md',
  'autopilot.history': 'autopilot.history.md',
}

const MCP_TOOLS = [
  'list_projects', 'get_project_summary', 'get_action_items', 'search_memories',
  'record_memory', 'supersede_memory', 'retract_memory', 'get_action_item_history',
  'get_session_transcript', 'claim_work_item', 'update_action_item', 'spin_off_action_item',
  'add_implementation_note', 'add_commit_reference', 'record_implementation',
  'generate_commit_message', 'create_action_item', 'record_completed_work',
  'verify_agent_connection', 'report_connection_check', 'get_next_work_item',
  'send_heartbeat', 'check_queue_status', 'get_action_item_siblings', 'submit_plan_review',
  'devspec_help_search', 'post_session_message',
  'verify_action_item',
]

const PREFLIGHT_SKILLS = new Set([
  'devspec.work', 'devspec.brainstorm', 'devspec.create', 'devspec.session-brainstorm',
  'devspec.done', 'devspec.verify-connection', 'devspec.link', 'devspec.commit',
  'autopilot.process',
])

const CURSOR_PREFLIGHT = `## Preflight — Verify DevSpec MCP availability

Before parsing the input or doing anything else, confirm the DevSpec MCP server is reachable from this chat:

1. Call \`devspec__list_projects\` with no arguments.
2. **If the call fails, the tool is not available, or any \`devspec__*\` tool is missing from your tool list**, stop immediately and tell the user:

   > **DevSpec MCP server is not reachable from this chat.** This usually means the chat thread was opened before the MCP server connected — for example, after editing \`~/.cursor/mcp.json\` or the DevSpec extension settings.
   >
   > **Fix:** Open a brand new Agent-mode chat and re-run this skill. Verify the \`devspec\` server shows green with all tools listed in **Cursor Settings → MCP & Integrations**.

   Do **not** proceed to file edits, branch creation, commits, or MCP mutations. Skipping this guard risks inconsistent DevSpec records.

The DevSpec MCP server is registered as \`devspec\` in \`mcp.json\`, so all MCP tool names are prefixed \`devspec__\`.

---

`

const CURSOR_NOTES = `

## Cursor-specific notes

- **Read before edit:** Always read a file before editing it — Cursor's edit tools require this.
- **Windows \`node_modules/.bin\` fallback:** If \`npm run <cmd>\` fails with a PATH error in a worktree, retry once using \`node ./node_modules/typescript/bin/tsc --noEmit\` (for tsc) or \`node ./node_modules/.bin/<cmd>\` for other binaries.
- **Stale chat MCP state:** If MCP was reconfigured, open a **new** Agent-mode chat — existing chats cache old tool availability.
- **Provider:** Always pass \`provider: "cursor"\` on completion/recording calls.
`

function parseFrontmatter(raw) {
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== '---') return { meta: {}, body: raw }
  const meta = {}
  let i = 1
  for (; i < lines.length; i++) {
    if (lines[i] === '---') break
    const m = lines[i].match(/^([\w.-]+):\s*(.*)$/)
    if (m && m[1] !== 'allowed-tools' && m[1] !== 'argument-hint') {
      meta[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  const body = lines.slice(i + 1).join('\n')
  return { meta, body }
}

function transformBody(body, skillName) {
  let out = body

  out = out.replace(/mcp__devspec__/g, 'devspec__')

  for (const tool of MCP_TOOLS) {
    const re = new RegExp(`(?<!devspec__)(?<![\\w])(${tool})(?=\\()`, 'g')
    out = out.replace(re, `devspec__$1`)
  }

  out = out.replace(/`complete_work_item`/g, '`devspec__record_implementation`')
  out = out.replace(/`fail_work_item`/g, '`devspec__update_action_item`')
  out = out.replace(/devspec__complete_work_item/g, 'devspec__record_implementation')
  out = out.replace(/devspec__fail_work_item/g, 'devspec__update_action_item')

  out = out.replace(/"claude_code"/g, '"cursor"')
  out = out.replace(/`claude_code`/g, '`cursor`')

  out = out.replace(/\/devspec:work/g, '`devspec.work`')
  out = out.replace(/\/devspec:brainstorm/g, '`devspec.brainstorm`')
  out = out.replace(/\/autopilot:start/g, '`autopilot.process` (Cursor one-shot — no polling)')
  out = out.replace(/\/autopilot:stop/g, '(not available in Cursor — no background polling)')
  out = out.replace(/\/autopilot\b/g, '`autopilot.process`')

  out = out.replace(/Claude Code's `CLAUDE\.md` \/ built-in notes/g, "your own local Cursor rules / notes")
  out = out.replace(/Claude Code's `CLAUDE\.md`/g, 'project docs (`CLAUDE.md`, `AGENTS.md`)')
  out = out.replace(/`claude --resume <id>`/g, '(session resume is Claude Code only — omit `local_session_id` in Cursor)')

  out = out.replace(
    /- `local_session_id`:[\s\S]*?Do NOT pass `machine_user_id`[^\n]*\n/g,
    '- **Cursor:** Omit `local_session_id` — session resume is not available from Cursor.\n',
  )
  out = out.replace(
    /- `local_session_id`[^\n]*\n/g,
    '',
  )
  out = out.replace(/\$\{CLAUDE_CODE_SESSION_ID[^}]*\}/g, '')
  out = out.replace(/\$\{CLAUDE_SESSION_ID[^}]*\}/g, '')
  out = out.replace(/echo "\$\{CLAUDE_CODE_SESSION_ID[^"]*"\}"/g, '')
  out = out.replace(/Get it by running this bash command[\s\S]*?Only if that command prints an empty line[^\n]*\n/g, '')

  if (skillName === 'devspec.work') {
    out = out.replace(
      /4\. If you are about to create a parallel implementation[\s\S]*?Never ship a parallel implementation silently\./,
      `4. If you are about to create a parallel implementation of something the codebase already has — **STOP**. Either extend the existing implementation, or (in unattended mode) fail the item with error \`"Requires human judgment: would duplicate <existing thing>, extension blocked by <specific reason>"\`. In interactive mode, ask the user before proceeding. Never ship a parallel implementation silently.`,
    )
  }

  return out
}

function buildSkill(skillName, body, description) {
  const preflight = PREFLIGHT_SKILLS.has(skillName) ? CURSOR_PREFLIGHT : `The DevSpec MCP server is registered as \`devspec\` in \`mcp.json\`, so all MCP tool names are prefixed \`devspec__\`.\n\n---\n\n`
  const notes = skillName !== 'devspec.help' ? CURSOR_NOTES : ''
  return `---
name: ${skillName}
description: ${description}
---

${preflight}${transformBody(body, skillName)}${notes}
`
}

function readClaudeCommand(filename) {
  const path = join(CLAUDE_ROOT, 'commands', filename)
  return readFileSync(path, 'utf8')
}

function writeSkill(skillName, content) {
  const dir = join(SKILLS_DIR, skillName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
  console.log(`  wrote skills/${skillName}/SKILL.md`)
}

function buildAutopilotProcess() {
  const startRaw = readClaudeCommand('autopilot.start.md')
  const { body: startBody } = parseFrontmatter(startRaw)
  const autopilotSkill = readFileSync(join(CLAUDE_ROOT, 'skills', 'autopilot', 'SKILL.md'), 'utf8')
  const { body: autopilotBody } = parseFrontmatter(autopilotSkill)

  const stagedSection = autopilotBody.match(
    /#### If agent_activity = 'staged' \(Full Execution\)([\s\S]*?)#### If agent_activity/m,
  )?.[1] ?? ''

  const failureSection = autopilotBody.match(
    /## Failure Handling([\s\S]*?)(## |$)/,
  )?.[1] ?? ''

  const body = `# DevSpec Autopilot — Process (Cursor one-shot)

Process staged DevSpec action items fully autonomously. **Cursor does not support background polling** — this skill processes **one item per invocation** by default. Use \`--items=<uuid1>,<uuid2>\` for a targeted batch, then exit.

## Input Parsing

Scan the user's invocation for flags (same semantics as Claude \`autopilot.start\`, minus polling):

- \`--project-id=<uuid>\` → \`project_id_override\`
- \`--mine\` (default) / \`--assigned-to=<uuid>\` / \`--all\` → assignee filter for \`get_next_work_item\`
- \`--created-by=<uuid>\` → creator filter (layers on assignee filter)
- \`--items=<uuid1>,<uuid2>,...\` → targeted FIFO queue; validate every UUID with \`^[0-9a-f-]{36}$\`; abort before any MCP call on invalid values
- When \`--items\` is present, set \`targeted_mode = true\` and process each UUID in order, then exit (no idle polling)

**Never pass \`force: true\` on \`claim_work_item\`.**

## Step 0 — Resolve project & load settings

1. Run \`git remote get-url origin\` and call \`devspec__list_projects({ git_remote: "<remote>" })\`.
   - Use \`project_id_override\` if set, else \`remote_match.resolved_project_id\`.
   - Multiple candidates → ask the user which project (or stop in unattended contexts).
   - No match → \`✗ No DevSpec project tracks this repo (<git_remote>).\` and stop.

2. Call \`devspec__get_project_summary({ project_id })\` and read the execution settings (the unified \`execution\` block — \`auto_push\`, \`auto_merge\`, \`custom_instructions\`, \`agent_rules\`, \`test_commands\`, \`protected_paths\`, … — plus the top-level \`owner_agent_rules\`; fall back to \`local_plugin_settings\` only if \`execution\` is absent) + \`repos\` + \`database_targets\`. Treat \`custom_instructions\` (team principles) and \`agent_rules\` + \`owner_agent_rules\` (execution mechanics) as mandatory when set.

3. Record \`starting_branch\` via \`git branch --show-current\`.

4. If autopilot is disabled in settings, print DISABLED banner and stop.

## Step 1 — Fetch work

**Targeted mode:** pop next UUID from queue; skip \`get_next_work_item\`; go to Step 2.

**Default mode:** call \`devspec__get_next_work_item({ project_id, assigned_to?, created_by? })\`.
- Empty → print \`No staged items — nothing to process.\`, send idle \`devspec__send_heartbeat\`, EXIT.
- **Never use \`get_action_items\` to fetch staged work in bulk** — context overflow risk.

## Step 2 — Process by agent_activity

Pick planning / under_human_review / staged per the Claude autopilot skill priority. For **staged** items, follow the full execution path below.

### Staged — full execution

${transformBody(stagedSection, 'autopilot.process')}

## Step 3 — Heartbeat & loop-back

1. Call \`devspec__send_heartbeat\` (best-effort) with \`status: "idle"\` or \`"working"\` as appropriate.

2. **Targeted mode:** if more UUIDs remain, return to Step 1. If queue empty, EXIT.

3. **Default mode:** EXIT after one item (re-run the skill for the next item).

## Failure Handling

${transformBody(failureSection, 'autopilot.process')}

On failure after a successful claim, call \`devspec__update_action_item\` with \`agent_activity: 'failed'\` and \`agent_error\`. **Never call \`update_action_item\` failed on a 409 claim rejection** — the item belongs to another runner.

## Argument reference (from autopilot.start)

${transformBody(startBody.replace(/^# Start DevSpec Autopilot[\s\S]*?## Steps\n\n/, ''), 'autopilot.process')}
`

  return buildSkill(
    'autopilot.process',
    body,
    'Process the next staged DevSpec action item (or a targeted list via --items=). Fully autonomous one-shot execution — no background polling. Cursor counterpart to a single autopilot cycle.',
  )
}

function removeLegacySkills() {
  const legacy = [
    'devspec-work', 'devspec-brainstorm', 'devspec-verify-connection',
    'autopilot-process', 'autopilot-status', 'autopilot-history',
  ]
  for (const name of legacy) {
    const dir = join(SKILLS_DIR, name)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`  removed legacy skills/${name}/`)
    }
  }
}

function main() {
  console.log('Syncing Cursor skills from Claude plugin...\n')
  removeLegacySkills()

  for (const [skillName, filename] of Object.entries(DIRECT_MAP)) {
    const raw = readClaudeCommand(filename)
    const { meta, body } = parseFrontmatter(raw)
    const content = buildSkill(skillName, body, meta.description || skillName)
    writeSkill(skillName, content)
  }

  writeSkill('autopilot.process', buildAutopilotProcess())

  console.log('\nDone.')
}

main()
