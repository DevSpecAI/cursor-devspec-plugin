#!/usr/bin/env node
/** The legacy bridge name forwards to the shared, signed-request-only service. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../launcher/launcher.mjs'
export * from '../launcher/open-bridge.mjs'
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(['serve']).catch(() => { console.error('DevSpec Launcher could not start.'); process.exitCode = 1 })
}
