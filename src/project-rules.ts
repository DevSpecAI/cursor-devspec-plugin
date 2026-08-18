import * as vscode from 'vscode'
import { promises as fs } from 'fs'
import * as path from 'path'
import { hasGitMetadata } from './project-rules-core.cjs'

/** Matches `<!-- devspec-autopilot-rules:N -->` in bundled / installed rules files. */
export const RULES_MARKER = /<!-- devspec-autopilot-rules:(\d+) -->/

export const RULES_RELATIVE_PATH = path.join('.cursor', 'rules', 'devspec.mdc')

export function rulesVersion(content: string): number | null {
  const match = content.match(RULES_MARKER)
  return match ? Number(match[1]) : null
}

export async function readBundledRules(extensionPath: string): Promise<string> {
  return fs.readFile(path.join(extensionPath, 'rules', 'devspec.mdc'), 'utf8')
}

function shouldUpgradeRules(existing: string, bundled: string): boolean {
  const installed = rulesVersion(existing)
  const latest = rulesVersion(bundled)
  return installed !== null && latest !== null && latest > installed
}

export async function installProjectRules(
  extensionPath: string,
  workspaceFolder: vscode.WorkspaceFolder,
  opts: { overwrite?: boolean } = {},
): Promise<'installed' | 'skipped_exists' | 'skipped_no_git'> {
  const root = workspaceFolder.uri.fsPath
  if (!await hasGitMetadata(root)) return 'skipped_no_git'

  const targetPath = path.join(root, RULES_RELATIVE_PATH)
  const bundled = await readBundledRules(extensionPath)

  try {
    const existing = await fs.readFile(targetPath, 'utf8')
    if (!opts.overwrite) {
      if (shouldUpgradeRules(existing, bundled)) {
        // Bundled rules are newer — fall through and overwrite.
      } else if (RULES_MARKER.test(existing)) {
        return 'skipped_exists'
      } else if (existing.trim().length > 0) {
        // User-owned file at the canonical path — do not clobber.
        return 'skipped_exists'
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, bundled, 'utf8')
  return 'installed'
}

export async function offerInstallProjectRules(
  context: vscode.ExtensionContext,
  extensionPath: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('devspec')
  const mode = config.get<string>('autoInstallRules') ?? 'prompt'
  if (mode === 'never') return

  const folders = vscode.workspace.workspaceFolders
  if (!folders?.length) return

  for (const folder of folders) {
    const skipKey = `devspec.rulesSkipped.${folder.uri.fsPath}`
    if (context.workspaceState.get<boolean>(skipKey)) continue

    const targetPath = path.join(folder.uri.fsPath, RULES_RELATIVE_PATH)
    const bundled = await readBundledRules(extensionPath)
    let existing: string | null = null
    try {
      existing = await fs.readFile(targetPath, 'utf8')
      if (existing && !shouldUpgradeRules(existing, bundled)) {
        if (RULES_MARKER.test(existing)) continue
        if (existing.trim().length > 0) continue
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }

    const upgrading =
      existing !== null && shouldUpgradeRules(existing, bundled)
    const installedVer = existing ? rulesVersion(existing) : null
    const bundledVer = rulesVersion(bundled)

    if (mode === 'always') {
      const result = await installProjectRules(extensionPath, folder)
      if (result === 'installed') {
        void vscode.window.showInformationMessage(
          upgrading
            ? `DevSpec: upgraded ${RULES_RELATIVE_PATH} in ${folder.name} (v${installedVer} → v${bundledVer}).`
            : `DevSpec: installed ${RULES_RELATIVE_PATH} in ${folder.name}.`,
        )
      }
      continue
    }

    const choice = await vscode.window.showInformationMessage(
      upgrading
        ? `DevSpec: upgrade project rules in "${folder.name}" (v${installedVer} → v${bundledVer})?`
        : `DevSpec: install project rules in "${folder.name}" (${RULES_RELATIVE_PATH})?`,
      upgrading ? 'Upgrade' : 'Install',
      'Not now',
      "Don't ask again",
    )
    if (choice === 'Install' || choice === 'Upgrade') {
      const result = await installProjectRules(extensionPath, folder)
      if (result === 'installed') {
        void vscode.window.showInformationMessage(
          upgrading
            ? `DevSpec: upgraded ${RULES_RELATIVE_PATH} (v${installedVer} → v${bundledVer}).`
            : `DevSpec: installed ${RULES_RELATIVE_PATH}.`,
        )
      } else if (result === 'skipped_no_git') {
        void vscode.window.showWarningMessage('DevSpec: open a git repository to install project rules.')
      } else {
        void vscode.window.showInformationMessage('DevSpec: rules file already exists — not overwritten.')
      }
    } else if (choice === "Don't ask again") {
      await context.workspaceState.update(skipKey, true)
    }
  }
}

export async function installProjectRulesCommand(
  _context: vscode.ExtensionContext,
  extensionPath: string,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders
  if (!folders?.length) {
    void vscode.window.showWarningMessage('DevSpec: open a workspace folder first.')
    return
  }

  let folder = folders[0]
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, folder: f })),
      { placeHolder: 'Which workspace folder should get DevSpec rules?' },
    )
    if (!picked) return
    folder = picked.folder
  }

  const targetPath = path.join(folder.uri.fsPath, RULES_RELATIVE_PATH)
  let overwrite = false
  try {
    const existing = await fs.readFile(targetPath, 'utf8')
    if (existing.trim().length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `${RULES_RELATIVE_PATH} already exists. Overwrite?`,
        'Overwrite',
        'Cancel',
      )
      if (choice !== 'Overwrite') return
      overwrite = true
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const result = await installProjectRules(extensionPath, folder, { overwrite })
  if (result === 'installed') {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath))
    await vscode.window.showTextDocument(doc, { preview: false })
    void vscode.window.showInformationMessage(`DevSpec: installed ${RULES_RELATIVE_PATH}.`)
  } else if (result === 'skipped_no_git') {
    void vscode.window.showWarningMessage('DevSpec: this folder is not a git repository.')
  } else {
    void vscode.window.showInformationMessage('DevSpec: rules file already exists — not overwritten.')
  }
}
