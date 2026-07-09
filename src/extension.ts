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

type SkillId =
  | 'devspec.work'
  | 'devspec.brainstorm'
  | 'devspec.create'
  | 'devspec.session-brainstorm'
  | 'devspec.verify-connection'
  | 'devspec.done'
  | 'devspec.help'
  | 'devspec.link'
  | 'devspec.commit'
  | 'autopilot.process'
  | 'autopilot.status'
  | 'autopilot.history'

interface SkillMeta {
  command: string
  promptLabel: string
  promptPlaceholder?: string
}

const SKILLS: Record<SkillId, SkillMeta> = {
  'devspec.work': {
    command: 'devspec.work',
    promptLabel: 'Action item title or ID (optional)',
    promptPlaceholder: 'e.g. "OAuth login bug", a UUID, or add --unattended',
  },
  'devspec.brainstorm': {
    command: 'devspec.brainstorm',
    promptLabel: 'Action item title or ID',
    promptPlaceholder: 'e.g. "OAuth login bug" or a UUID',
  },
  'devspec.create': {
    command: 'devspec.create',
    promptLabel: 'Title and optional fields',
    promptPlaceholder: 'title: Fix login bug  type: bug  priority: high',
  },
  'devspec.session-brainstorm': {
    command: 'devspec.session-brainstorm',
    promptLabel: 'Session handoff arguments',
    promptPlaceholder: 'mode=answer session_id=<uuid>  or  mode=brainstorm session_id=<uuid>',
  },
  'devspec.verify-connection': {
    command: 'devspec.verify-connection',
    promptLabel: 'Verification UUID (leave empty for ping mode)',
    promptPlaceholder: 'empty = ping mode  ·  or paste setup-wizard UUID for commit mode',
  },
  'devspec.done': {
    command: 'devspec.done',
    promptLabel: 'Optional description (auto-infers from git if empty)',
    promptPlaceholder: 'leave empty to infer from recent commits',
  },
  'devspec.help': {
    command: 'devspec.help',
    promptLabel: 'Your question about using DevSpec',
    promptPlaceholder: 'e.g. "How do I set up autopilot?"',
  },
  'devspec.link': {
    command: 'devspec.link',
    promptLabel: 'Commit SHA and action item ID',
    promptPlaceholder: '<sha> <action_item_id>',
  },
  'devspec.commit': {
    command: 'devspec.commit',
    promptLabel: 'Action item ID and commit summary',
    promptPlaceholder: '<action_item_id> <summary under 72 chars>',
  },
  'autopilot.process': {
    command: 'devspec.autopilot.process',
    promptLabel: 'Optional flags — leave empty for next staged item',
    promptPlaceholder: '--items=<uuid1>,<uuid2>  ·  --mine  ·  --all  ·  --assigned-to=<uuid>',
  },
  'autopilot.status': {
    command: 'devspec.autopilot.status',
    promptLabel: '',
  },
  'autopilot.history': {
    command: 'devspec.autopilot.history',
    promptLabel: '',
  },
}

let extensionContext: vscode.ExtensionContext | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context
  registerRepoFolderFeatures(context)
  registerProtocolHandlerCommands(context)
  installProtocolHandler(context.extensionPath)

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
  )

  void registerMcpServer({ force: false, context })
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

  const header = userInput
    ? `Run the \`${skillId}\` skill with this input: ${userInput}`
    : `Run the \`${skillId}\` skill.`
  const prompt = `${header}\n\n---\n\n${skillBody}`

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
