/**
 * Build a standalone Windows handler executable with pkg (optional).
 * Falls back gracefully when pkg is not installed — devspec-handler.cmd uses node.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const outDir = path.join(root, 'bin')
const entry = path.join(__dirname, 'open-handler.mjs')

async function main() {
  await fs.mkdir(outDir, { recursive: true })

  const outPath = path.join(outDir, 'devspec-open-handler.exe')
  const pkgArgs = [entry, '-t', 'node18-win-x64', '-o', outPath, '--compress', 'GZip']

  await new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'pkg', ...pkgArgs], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pkg exited with code ${code}`))
    })
    child.on('error', reject)
  })

  console.log('[devspec] built bin/devspec-open-handler.exe')
}

main().catch((err) => {
  console.warn('[devspec] handler exe build skipped:', err.message)
  process.exit(0)
})
