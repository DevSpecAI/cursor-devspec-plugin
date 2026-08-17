import * as vscode from 'vscode'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  installProjectRulesCommand,
  offerInstallProjectRules,
} from './project-rules'
import { installProtocolHandler, registerProtocolHandlerCommands } from './protocol-handler-install'
import { registerRepoFolderFeatures } from './repo-folder-map'
import { buildSkillPastePrompt } from './skill-paste-prompt'

/*
 * Two skills. The other nine were a page of prose each, telling a model to call
 * one DevSpec MCP tool it could already see; what they taught now lives in the
 * tool schemas server-side. These two survive because connecting runs a real
 * setup a model improvises badly — that is what earns a command.
 */
type SkillId = 'devspec.remote' | 'devspec.remote-stop'

interface SkillMeta {
  command: string
  promptLabel: string
  promptPlaceholder?: string
}

const SKILLS: Record<SkillId, SkillMeta> = {
  'devspec.remote': {
    command: 'devspec.remote',
    promptLabel: 'Optional title or note (leave empty to connect)',
    promptPlaceholder: '--title="My local agent"  or a short note',
  },
  'devspec.remote-stop': {
    command: 'devspec.remote-stop',
    promptLabel: '',
  },
}

let extensionContext: vscode.ExtensionContext | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context
  registerRepoFolderFeatures(context)
  registerProtocolHandlerCommands(context)
  installProtocolHandler(context.extensionPath)
  // Wire remote-control turn mirroring into Cursor Agent hooks (UserPromptSubmit/Stop).
  void installRemoteControlHooks(context.extensionPath)

  for (const [skillId, meta] of Object.entries(SKILLS) as [SkillId, SkillMeta][]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(meta.command, () => runSkill(context, skillId, meta)),
    )
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('devspec.setToken', () => promptAndStoreToken()),
    vscode.commands.registerCommand('devspec.registerMcpServer', () =>
      registerMcpServer({ force: true, context: extensionContext }),
    ),
    vscode.commands.registerCommand('devspec.installProjectRules', () =>
      installProjectRulesCommand(context, context.extensionPath),
    ),
    vscode.commands.registerCommand('devspec.installRemoteControlHooks', () =>
      installRemoteControlHooks(context.extensionPath, { forceNotify: true }),
    ),
  )

  void registerMcpServer({ force: false, context })
}

/**
 * Copy the version-stable mirror-turn launcher into ~/.cursor/devspec/hooks/
 * and return its absolute path. Hooks.json must point here — never at a
 * version-numbered extension directory (item 2097651e / fe456bf9).
 */
async function installStableMirrorLauncher(extensionPath: string): Promise<string | null> {
  const source = path.join(extensionPath, 'hooks', 'scripts', 'run-mirror-turn.mjs')
  try {
    await fs.access(source)
  } catch {
    return null
  }
  const destDir = path.join(os.homedir(), '.cursor', 'devspec', 'hooks')
  const dest = path.join(destDir, 'run-mirror-turn.mjs')
  await fs.mkdir(destDir, { recursive: true })
  await fs.copyFile(source, dest)
  return dest
}

/**
 * Merge DevSpec remote-control hooks into ~/.cursor/hooks.json so
 * beforeSubmitPrompt / stop fire the stable run-mirror-turn launcher (literal
 * local prompts + trail seed + busy/turn-end), and mid-turn tool/shell/file/MCP
 * hooks grow phase=trail. Idempotent: rewrites only our marker-tagged entries;
 * leaves other hooks alone.
 */
async function installRemoteControlHooks(
  extensionPath: string,
  opts: { forceNotify?: boolean } = {},
): Promise<void> {
  const stableLauncher = await installStableMirrorLauncher(extensionPath)
  if (!stableLauncher) {
    if (opts.forceNotify) {
      void vscode.window.showWarningMessage(
        'DevSpec: run-mirror-turn.mjs not found in the extension — reinstall the plugin.',
      )
    }
    return
  }

  const hooksPath = path.join(os.homedir(), '.cursor', 'hooks.json')
  type HookCmd = { command?: string; type?: string; timeout?: number; [k: string]: unknown }
  type HookGroup = { hooks?: HookCmd[]; matcher?: string; [k: string]: unknown }
  type HooksFile = { hooks?: Record<string, HookGroup[] | HookCmd[]>; [k: string]: unknown }

  let file: HooksFile = { hooks: {} }
  try {
    const raw = await fs.readFile(hooksPath, 'utf8')
    file = JSON.parse(raw) as HooksFile
    if (!file.hooks || typeof file.hooks !== 'object') file.hooks = {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (opts.forceNotify) {
        void vscode.window.showErrorMessage(`DevSpec: could not read ${hooksPath}`)
      }
      return
    }
    await fs.mkdir(path.dirname(hooksPath), { recursive: true })
  }

  const marker = 'devspec-remote-mirror'
  const userPromptCmd = `node "${stableLauncher}" user_prompt # ${marker}`
  const stopCmd = `node "${stableLauncher}" stop # ${marker}`
  const trailCmd = (mode: string) => `node "${stableLauncher}" ${mode} # ${marker}`

  /** Mid-turn work-trail events (Cursor camelCase). CLI may skip some; tool hooks are the reliable path. */
  const trailEvents = [
    'postToolUse',
    'postToolUseFailure',
    'afterShellExecution',
    'beforeShellExecution',
    'afterMCPExecution',
    'beforeMCPExecution',
    'afterFileEdit',
    'afterAgentThought',
  ] as const

  const isOurs = (cmd: unknown) =>
    typeof cmd === 'string' &&
    (cmd.includes(marker) ||
      cmd.includes('mirror-turn.mjs') ||
      cmd.includes('trail-turn.mjs') ||
      cmd.includes('run-mirror-turn.mjs'))

  const stripOursFromGroups = (groups: unknown): HookGroup[] => {
    if (!Array.isArray(groups)) return []
    return groups
      .map((g) => {
        if (!g || typeof g !== 'object') return null
        const group = g as HookGroup
        if (Array.isArray(group.hooks)) {
          const hooks = group.hooks.filter((h) => !isOurs(h?.command))
          if (hooks.length === 0) return null
          return { ...group, hooks }
        }
        // Flat Cursor style: { command: "..." }
        if (isOurs((group as HookCmd).command)) return null
        return group
      })
      .filter(Boolean) as HookGroup[]
  }

  const hooks = file.hooks!
  // Cursor native: beforeSubmitPrompt / stop (camelCase). Also keep UserPromptSubmit/Stop
  // for harnesses that load this file with Claude-compatible names. Strip + re-add trail events.
  for (const key of [
    'beforeSubmitPrompt',
    'UserPromptSubmit',
    'stop',
    'Stop',
    ...trailEvents,
  ] as const) {
    hooks[key] = stripOursFromGroups(hooks[key])
  }

  const pushClaudeStyle = (event: string, command: string) => {
    const list = (hooks[event] as HookGroup[]) || []
    list.push({ hooks: [{ type: 'command', command, timeout: 30 }] })
    hooks[event] = list
  }
  const pushCursorStyle = (event: string, command: string) => {
    const list = (hooks[event] as HookGroup[]) || []
    list.push({ command })
    hooks[event] = list
  }

  pushCursorStyle('beforeSubmitPrompt', userPromptCmd)
  pushCursorStyle('stop', stopCmd)
  pushClaudeStyle('UserPromptSubmit', userPromptCmd)
  pushClaudeStyle('Stop', stopCmd)
  for (const event of trailEvents) {
    pushCursorStyle(event, trailCmd(event))
  }

  file.hooks = hooks
  await fs.writeFile(hooksPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  if (opts.forceNotify) {
    void vscode.window.showInformationMessage(
      'DevSpec: remote-control mirror + work-trail hooks installed (stable path under ~/.cursor/devspec/hooks/).',
    )
  }
}

export function deactivate(): void {
  // No-op
}

async function runSkill(context: vscode.ExtensionContext, skillId: SkillId, meta: SkillMeta): Promise<void> {
  const skillPath = path.join(context.extensionPath, 'skills', skillId, 'SKILL.md')
  let skillBody: string
  try {
    skillBody = await fs.readFile(skillPath, 'utf8')
  } catch {
    void vscode.window.showErrorMessage(`DevSpec: skill "${skillId}" not found at ${skillPath}.`)
    return
  }

  let userInput: string | undefined
  if (meta.promptLabel) {
    userInput = await vscode.window.showInputBox({
      prompt: meta.promptLabel,
      placeHolder: meta.promptPlaceholder,
      ignoreFocusOut: true,
    })
    if (userInput === undefined) return
    userInput = userInput.trim()
  }

  const prompt = buildSkillPastePrompt(skillId, skillBody, userInput, context.extensionPath)

  await vscode.env.clipboard.writeText(prompt)
  void vscode.window.showInformationMessage(
    `DevSpec: ${skillId} prompt copied. Paste into Cursor chat (Ctrl+L) to run.`,
  )
}

async function promptAndStoreToken(opts: { skipReregister?: boolean } = {}): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    prompt: 'Paste your DevSpec MCP token (starts with dvs_)',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value && !value.startsWith('dvs_') ? 'Token should start with "dvs_"' : null,
  })
  if (!entered) return undefined
  await vscode.workspace.getConfiguration('devspec').update('mcpToken', entered, vscode.ConfigurationTarget.Global)
  if (!opts.skipReregister) {
    void vscode.window.showInformationMessage('DevSpec: token saved. Re-registering MCP server.')
    await registerMcpServer({ force: true, context: extensionContext })
  }
  return entered
}

async function registerMcpServer({
  force,
  context,
}: {
  force: boolean
  context?: vscode.ExtensionContext
}): Promise<void> {
  const config = vscode.workspace.getConfiguration('devspec')
  let apiUrl = (config.get<string>('apiUrl') ?? '').replace(/\/+$/, '')
  let token = config.get<string>('mcpToken') ?? ''

  if (!apiUrl || !token) {
    if (!force) {
      const choice = await vscode.window.showInformationMessage(
        'DevSpec: not yet configured. Connect now?',
        'Connect',
        'Later',
      )
      if (choice !== 'Connect') return
    }
  }

  if (!apiUrl) {
    const entered = await vscode.window.showInputBox({
      prompt: 'DevSpec API URL',
      placeHolder: 'e.g. https://staging.devspec.ai',
      value: 'https://staging.devspec.ai',
      ignoreFocusOut: true,
      validateInput: (v) => /^https?:\/\/[^\s]+$/.test(v) ? null : 'Must be a valid http(s) URL',
    })
    if (!entered) return
    apiUrl = entered.replace(/\/+$/, '')
    await config.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global)
  }

  if (!token) {
    const entered = await promptAndStoreToken({ skipReregister: true })
    if (!entered) return
    token = entered
  }

  const cursorMcpPath = path.join(os.homedir(), '.cursor', 'mcp.json')
  let mcpConfig: { mcpServers?: Record<string, unknown> } = { mcpServers: {} }
  try {
    const existing = await fs.readFile(cursorMcpPath, 'utf8')
    mcpConfig = JSON.parse(existing)
    if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
      mcpConfig.mcpServers = {}
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      void vscode.window.showErrorMessage(`DevSpec: could not read ${cursorMcpPath}. Check permissions or fix the file manually.`)
      return
    }
    await fs.mkdir(path.dirname(cursorMcpPath), { recursive: true })
  }

  const desired = {
    type: 'http',
    url: `${apiUrl}/api/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  }
  const existing = mcpConfig.mcpServers!.devspec
  if (!force && JSON.stringify(existing) === JSON.stringify(desired)) {
    if (context) {
      void offerInstallProjectRules(context, context.extensionPath)
      installProtocolHandler(context.extensionPath)
    }
    return
  }

  mcpConfig.mcpServers!.devspec = desired
  await fs.writeFile(cursorMcpPath, JSON.stringify(mcpConfig, null, 2), 'utf8')

  if (force) {
    void vscode.window.showInformationMessage(
      'DevSpec: MCP server registered in ~/.cursor/mcp.json. Restart Cursor to pick it up.',
    )
  }

  if (context) {
    void offerInstallProjectRules(context, context.extensionPath)
    installProtocolHandler(context.extensionPath)
  }
}
