import * as vscode from 'vscode'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Shared with scripts/open-bridge.mjs — readable outside the extension host. */
export const DEVSPEC_SHARED_DIR = path.join(os.homedir(), '.cursor', 'devspec')
export const DEVSPEC_SHARED_MAP_PATH = path.join(DEVSPEC_SHARED_DIR, 'repo-folder-map.json')

export type RepoFolderMap = Record<string, string>

const GLOBAL_STATE_KEY = 'devspec.repoFolderMap'

export async function ensureSharedDevspecDir(): Promise<void> {
  await fs.mkdir(DEVSPEC_SHARED_DIR, { recursive: true })
}

export async function readSharedRepoFolderMap(): Promise<RepoFolderMap> {
  try {
    const raw = await fs.readFile(DEVSPEC_SHARED_MAP_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as RepoFolderMap) : {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function writeSharedRepoFolderMap(map: RepoFolderMap): Promise<void> {
  await ensureSharedDevspecDir()
  await fs.writeFile(DEVSPEC_SHARED_MAP_PATH, JSON.stringify(map, null, 2), 'utf8')
}

export function getGlobalRepoFolderMap(context: vscode.ExtensionContext): RepoFolderMap {
  return context.globalState.get<RepoFolderMap>(GLOBAL_STATE_KEY) ?? {}
}

/** Merge extension globalState into the shared JSON file (bridge reads this). */
export async function migrateGlobalRepoMapToSharedFile(
  context: vscode.ExtensionContext,
): Promise<RepoFolderMap> {
  const globalMap = getGlobalRepoFolderMap(context)
  const sharedMap = await readSharedRepoFolderMap()
  const merged = { ...sharedMap, ...globalMap }
  if (JSON.stringify(merged) !== JSON.stringify(sharedMap)) {
    await writeSharedRepoFolderMap(merged)
  }
  if (JSON.stringify(merged) !== JSON.stringify(globalMap)) {
    await context.globalState.update(GLOBAL_STATE_KEY, merged)
  }
  return merged
}

export async function persistRepoFolderMap(
  context: vscode.ExtensionContext,
  map: RepoFolderMap,
): Promise<void> {
  await context.globalState.update(GLOBAL_STATE_KEY, map)
  await writeSharedRepoFolderMap(map)
}
