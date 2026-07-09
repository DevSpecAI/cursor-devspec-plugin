import * as vscode from 'vscode'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { DEVSPEC_LOCAL_OPEN_BASE, startLocalOpenServer } from './local-open-server'

const execFileAsync = promisify(execFile)

/** Legacy cursor:// handler (marketplace install on external links — prefer localhost). */
export const CURSOR_URI_OPEN_SCHEME = 'cursor://devspecai.devspec-autopilot/open'
/** Browser handoff URL — keep port/path in sync with DevSpecV2 connect-clients. */
export { DEVSPEC_LOCAL_OPEN_BASE }
const GLOBAL_STATE_KEY = 'devspec.repoFolderMap'

export type RepoFolderMap = Record<string, string>

export function getRepoFolderMap(context: vscode.ExtensionContext): RepoFolderMap {
  return context.globalState.get<RepoFolderMap>(GLOBAL_STATE_KEY) ?? {}
}

async function persistRepoFolderMap(
  context: vscode.ExtensionContext,
  map: RepoFolderMap,
): Promise<void> {
  await context.globalState.update(GLOBAL_STATE_KEY, map)
}

export async function setRepoFolderMapping(
  context: vscode.ExtensionContext,
  slug: string,
  folderPath: string,
): Promise<void> {
  await persistRepoFolderMap(context, { ...getRepoFolderMap(context), [slug]: folderPath })
}

export async function removeRepoFolderMapping(
  context: vscode.ExtensionContext,
  slug: string,
): Promise<void> {
  const map = getRepoFolderMap(context)
  if (!(slug in map)) return
  const { [slug]: _removed, ...rest } = map
  await persistRepoFolderMap(context, rest)
}

export function parseGitHubSlug(remoteUrl: string): string | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s#?.]+)/i)
  if (!match?.[1] || !match[2]) return null
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`
}

export async function detectWorkspaceRepoSlug(folderPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', folderPath, 'remote', 'get-url', 'origin'], {
      timeout: 5000,
    })
    return parseGitHubSlug(stdout)
  } catch {
    return null
  }
}

async function isGitWorkspace(folder: vscode.WorkspaceFolder): Promise<boolean> {
  try {
    const gitPath = vscode.Uri.joinPath(folder.uri, '.git')
    const stat = await vscode.workspace.fs.stat(gitPath)
    return stat.type === vscode.FileType.Directory || stat.type === vscode.FileType.File
  } catch {
    return false
  }
}

export async function learnWorkspaceMappings(context: vscode.ExtensionContext): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!(await isGitWorkspace(folder))) continue
    const slug = await detectWorkspaceRepoSlug(folder.uri.fsPath)
    if (slug) {
      await setRepoFolderMapping(context, slug, folder.uri.fsPath)
    }
  }
}

async function folderPathExists(folderPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(folderPath))
    return true
  } catch {
    return false
  }
}

export async function resolveRepoFolder(
  context: vscode.ExtensionContext,
  slug: string,
): Promise<string | null> {
  const stored = getRepoFolderMap(context)[slug]
  if (stored && (await folderPathExists(stored))) {
    return stored
  }

  const choice = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: `Select local folder for ${slug}`,
    title: `DevSpec: choose local folder for ${slug}`,
  })
  if (!choice?.[0]) return null
  const folderPath = choice[0].fsPath
  await setRepoFolderMapping(context, slug, folderPath)
  return folderPath
}

export async function openLocalFolder(folderPath: string): Promise<void> {
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folderPath), {
    forceNewWindow: hasWorkspace,
  })
}

export async function openRepoBySlug(
  context: vscode.ExtensionContext,
  slug: string,
): Promise<void> {
  void vscode.window.showInformationMessage(`DevSpec: opening ${slug}…`)

  const stored = getRepoFolderMap(context)[slug]
  const folderPath =
    stored && (await folderPathExists(stored))
      ? stored
      : await resolveRepoFolder(context, slug)

  if (!folderPath) {
    void vscode.window.showInformationMessage(`DevSpec: no folder selected for ${slug}.`)
    return
  }

  await openLocalFolder(folderPath)
}

export function createUriHandler(context: vscode.ExtensionContext): vscode.UriHandler {
  return {
    handleUri: async (uri: vscode.Uri) => {
      const route = uri.path.replace(/^\//, '')
      const repo = new URLSearchParams(uri.query).get('repo')

      if (route && route !== 'open') {
        void vscode.window.showWarningMessage(`DevSpec: unrecognized URI route "${route}".`)
        return
      }
      if (!repo) {
        void vscode.window.showErrorMessage('DevSpec: missing repo query parameter.')
        return
      }

      await openRepoBySlug(context, decodeURIComponent(repo))
    },
  }
}
export async function manageRepoFolderMappings(context: vscode.ExtensionContext): Promise<void> {
  const map = getRepoFolderMap(context)
  const slugs = Object.keys(map).sort()
  if (slugs.length === 0) {
    void vscode.window.showInformationMessage('DevSpec: no stored repo folder mappings yet.')
    return
  }

  const picked = await vscode.window.showQuickPick(
    slugs.map((slug) => ({ label: slug, description: map[slug], slug })),
    { placeHolder: 'Select a repo mapping to update or remove' },
  )
  if (!picked) return

  const action = await vscode.window.showQuickPick(
    [
      { label: 'Re-point to a different folder', id: 'repick' as const },
      { label: 'Forget this mapping', id: 'forget' as const },
    ],
    { placeHolder: picked.slug },
  )
  if (!action) return

  if (action.id === 'forget') {
    await removeRepoFolderMapping(context, picked.slug)
    void vscode.window.showInformationMessage(`DevSpec: forgot folder mapping for ${picked.slug}.`)
    return
  }

  const choice = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: `Select folder for ${picked.slug}`,
  })
  if (!choice?.[0]) return

  await setRepoFolderMapping(context, picked.slug, choice[0].fsPath)
  void vscode.window.showInformationMessage(`DevSpec: updated folder for ${picked.slug}.`)
}

export function registerRepoFolderFeatures(context: vscode.ExtensionContext): void {
  startLocalOpenServer(context, (slug) => openRepoBySlug(context, slug))
  context.subscriptions.push(vscode.window.registerUriHandler(createUriHandler(context)))
  context.subscriptions.push(
    vscode.commands.registerCommand('devspec.forgetRepoFolder', () =>
      manageRepoFolderMappings(context),
    ),
  )

  void learnWorkspaceMappings(context)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void learnWorkspaceMappings(context)
    }),
  )
}
