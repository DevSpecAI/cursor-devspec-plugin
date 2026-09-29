#!/usr/bin/env node
/** Compatibility command; the shared generated launcher owns installation. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../launcher/launcher.mjs'
import { setupCursorLauncher } from './setup-launcher.mjs'
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  try {
    if (args.includes('--install')) {
      const result = await setupCursorLauncher()
      console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1
    } else {
      const at = args.indexOf('--url')
      const forwarded = at >= 0 ? ['open', args[at + 1]] : args.length === 1 && args[0].startsWith('devspec:') ? ['open', args[0]] : args
      const code = await main(forwarded)
      if (code !== undefined) process.exitCode = code
    }
  } catch { console.error('DevSpec local launching could not be configured. Copy commands remain available.'); process.exitCode = 1 }
}
