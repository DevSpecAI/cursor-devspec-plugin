import type { Stats } from 'node:fs'

export function hasGitMetadata(
  root: string,
  stat?: (path: string) => Promise<Stats>,
): Promise<boolean>
