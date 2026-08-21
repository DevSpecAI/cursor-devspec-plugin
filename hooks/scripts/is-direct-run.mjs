import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * True when this ESM file is the process entrypoint, even if argv[1] is a
 * Windows junction / symlink (ProgramData pin) and import.meta.url is the
 * real target. path.resolve equality is not enough: Node loads the real
 * path while Cursor Shell keeps the junction path in argv.
 */
export function isDirectRun(metaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !metaUrl) return false
  const metaPath = fileURLToPath(metaUrl)
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(path.resolve(metaPath))
  } catch {
    return path.resolve(argv1) === path.resolve(metaPath)
  }
}
