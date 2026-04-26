import * as vscode from 'vscode'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'

type SkillId = 'devspec-work' | 'devspec-brainstorm' | 'autopilot-process' | 'autopilot-status' | 'autopilot-history'

const SKILLS: Record<SkillId, { command: string; promptLabel: string }> = {
  'devspec-work':       { command: 'devspec.work',               promptLabel: 'Action item title or ID (optional)' },
  'devspec-brainstorm': { command: 'devspec.brainstorm',         promptLabel: 'Action item title or ID' },
  'autopilot-process':  { command: 'devspec.autopilot.process',  promptLabel: '' },
  'autopilot-status':   { command: 'devspec.autopilot.status',   promptLabel: '' },
  'autopilot-history':  { command: 'devspec.autopilot.history',  promptLabel: '' },
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  for (const [skillId, meta] of Object.entries(SKILLS) as [SkillId, typeof SKILLS[SkillId]][]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(meta.command, () => runSkill(context, skillId, meta.promptLabel)),
    )
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('devspec.setToken', () => promptAndStoreToken()),
    vscode.commands.registerCommand('devspec.registerMcpServer', () => registerMcpServer({ force: true })),
  )

  void registerMcpServer({ force: false })
}

export function deactivate(): void {
  // No-op
}

async function runSkill(context: vscode.ExtensionContext, skillId: SkillId, promptLabel: string): Promise<void> {
  const skillPath = path.join(context.extensionPath, 'skills', skillId, 'SKILL.md')
  let skillBody: string
  try {
    skillBody = await fs.readFile(skillPath, 'utf8')
  } catch {
    void vscode.window.showErrorMessage(`DevSpec: skill "${skillId}" not found at ${skillPath}.`)
    return
  }

  let userInput: string | undefined
  if (promptLabel) {
    userInput = await vscode.window.showInputBox({
      prompt: promptLabel,
      placeHolder: 'e.g. "OAuth login bug" or a UUID',
      ignoreFocusOut: true,
    })
    if (userInput === undefined) return
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

async function promptAndStoreToken(): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    prompt: 'Paste your DevSpec MCP token (starts with dvs_)',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value && !value.startsWith('dvs_') ? 'Token should start with "dvs_"' : null,
  })
  if (!entered) return undefined
  await vscode.workspace.getConfiguration('devspec').update('mcpToken', entered, vscode.ConfigurationTarget.Global)
  void vscode.window.showInformationMessage('DevSpec: token saved. Re-registering MCP server.')
  await registerMcpServer({ force: true })
  return entered
}

async function registerMcpServer({ force }: { force: boolean }): Promise<void> {
  const config = vscode.workspace.getConfiguration('devspec')
  const apiUrl = (config.get<string>('apiUrl') ?? 'https://app.devspec.ai').replace(/\/+$/, '')
  let token = config.get<string>('mcpToken') ?? ''

  if (!token) {
    if (!force) {
      const choice = await vscode.window.showInformationMessage(
        'DevSpec: no MCP token configured. Set one to enable the integration.',
        'Set token',
        'Later',
      )
      if (choice !== 'Set token') return
    }
    const entered = await promptAndStoreToken()
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
    return
  }

  mcpConfig.mcpServers!.devspec = desired
  await fs.writeFile(cursorMcpPath, JSON.stringify(mcpConfig, null, 2), 'utf8')

  if (force) {
    void vscode.window.showInformationMessage(
      'DevSpec: MCP server registered in ~/.cursor/mcp.json. Restart Cursor to pick it up.',
    )
  }
}
