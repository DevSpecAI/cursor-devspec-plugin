#!/usr/bin/env node
/**
 * DevSpec ephemeral protocol handler — invoked by the OS for devspec:// URLs.
 * Also supports --install (copy to ~/.cursor/devspec) and macOS --serve fallback.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEVSPEC_DIR,
  DEVSPEC_LOCAL_OPEN_PORT,
  ensureDevspecDir,
  handleProtocolUrl,
  appendHandlerLog,
  writeExtensionRootMarker,
} from './open-handler-core.mjs'
import { ensureSpaceSafePluginPin } from './space-safe-plugin-root.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const INSTALLED_HANDLER = path.join(DEVSPEC_DIR, 'open-handler.mjs')

async function copyInstalledArtifacts(sourceDir) {
  await ensureDevspecDir()
  // sourceDir is …/extension/scripts — record the extension package root so
  // protocol CLI launches prefer that tree over a stale DEVSPEC_DIR copy.
  const extensionRoot = path.resolve(sourceDir, '..')
  await writeExtensionRootMarker(extensionRoot)
  ensureSpaceSafePluginPin(extensionRoot)

  const files = [
    'open-handler.mjs',
    'open-handler-core.mjs',
    'pin-remote-plugin.mjs',
    'space-safe-plugin-root.mjs',
    'launch-cli-session.mjs',
    'launch-opencode-session.mjs',
    'launch-pi-session.mjs',
    'opencode-mapped-permissions.mjs',
    'handoff-verify.mjs',
    'handoff-public-key.pem',
    'devspec-handler.cmd',
    'devspec-handler.vbs',
    'devspec-handler.sh',
    // Needed only for --install / reinstall from the installed copy; URL
    // handling does not import these (lazy-loaded below). Keep them so a
    // reinstall from ~/.cursor/devspec still works.
    'register-protocol.mjs',
    'open-bridge.mjs',
    'open-bridge-pages.mjs',
  ]
  for (const name of files) {
    const src = path.join(sourceDir, name)
    try {
      await fs.copyFile(src, path.join(DEVSPEC_DIR, name))
    } catch {
      // optional files (e.g. exe) may be absent in dev
    }
  }

  if (process.platform !== 'win32') {
    // A .desktop Exec target must be executable and packing does not reliably
    // preserve the mode bit.
    try {
      await fs.chmod(path.join(DEVSPEC_DIR, 'devspec-handler.sh'), 0o755)
    } catch {
      // absent in dev / already correct
    }
  }

  const binExe = path.join(sourceDir, 'bin', 'devspec-open-handler.exe')
  try {
    await fs.mkdir(path.join(DEVSPEC_DIR, 'bin'), { recursive: true })
    await fs.copyFile(binExe, path.join(DEVSPEC_DIR, 'bin', 'devspec-open-handler.exe'))
  } catch {
    // exe built separately
  }

  // Mirror hooks/scripts next to the installed launchers so the fallback
  // `../hooks/scripts/*` imports from DEVSPEC_DIR resolve when the extension
  // root is missing. Primary launches use the extension path from the marker.
  const hooksSrcDir = path.join(extensionRoot, 'hooks', 'scripts')
  const hooksScriptsDest = path.join(DEVSPEC_DIR, 'hooks', 'scripts')
  await fs.mkdir(hooksScriptsDest, { recursive: true })
  try {
    const hookEntries = await fs.readdir(hooksSrcDir, { withFileTypes: true })
    for (const entry of hookEntries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js')) continue
      // Skip unit tests in the install mirror.
      if (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.test.js')) continue
      try {
        await fs.copyFile(
          path.join(hooksSrcDir, entry.name),
          path.join(hooksScriptsDest, entry.name),
        )
      } catch {
        // best-effort per file
      }
    }
  } catch {
    // hooks tree may be absent in a stripped package
  }

  // Also place a copy where `../hooks/scripts` from DEVSPEC_DIR resolves
  // (`~/.cursor/hooks/scripts`) — launch-cli-session uses that relative import.
  const cursorHooksScripts = path.join(path.dirname(DEVSPEC_DIR), 'hooks', 'scripts')
  await fs.mkdir(cursorHooksScripts, { recursive: true })
  try {
    const hookEntries = await fs.readdir(hooksScriptsDest, { withFileTypes: true })
    for (const entry of hookEntries) {
      if (!entry.isFile()) continue
      try {
        await fs.copyFile(
          path.join(hooksScriptsDest, entry.name),
          path.join(cursorHooksScripts, entry.name),
        )
      } catch {
        // best-effort
      }
    }
  } catch {
    // ignore
  }

  // Stable mirror-turn launcher for ~/.cursor/hooks.json (item 2097651e / fe456bf9).
  // Prefer the sibling hooks/scripts copy in the plugin checkout; fall back to a
  // previously installed copy under DEVSPEC_DIR/hooks.
  const hooksDestDir = path.join(DEVSPEC_DIR, 'hooks')
  await fs.mkdir(hooksDestDir, { recursive: true })
  const launcherName = 'run-mirror-turn.mjs'
  const launcherCandidates = [
    path.join(sourceDir, '..', 'hooks', 'scripts', launcherName),
    path.join(sourceDir, 'hooks', launcherName),
    path.join(DEVSPEC_DIR, 'hooks', launcherName),
    path.join(hooksScriptsDest, launcherName),
  ]
  for (const src of launcherCandidates) {
    try {
      await fs.copyFile(src, path.join(hooksDestDir, launcherName))
      break
    } catch {
      // try next
    }
  }
}

async function runFromUrlArg(urlArg) {
  const result = await handleProtocolUrl(urlArg, {
    requireSignedToken: process.platform !== 'darwin',
  })
  if (!result.ok) {
    // bad_url already logged with the raw URL preview in handleProtocolUrl
    if (result.error !== 'bad_url') {
      await appendHandlerLog(`handoff failed: ${result.error}`)
    }
    process.exitCode = 1
  }
}

async function main() {
  const args = process.argv.slice(2)

  // Always record invocations so silent Windows failures are diagnosable.
  try {
    await appendHandlerLog(`invoke argv=${JSON.stringify(args)}`)
  } catch {
    // ignore
  }

  if (args.includes('--install')) {
    await copyInstalledArtifacts(__dirname)
    // Lazy-load so URL-only invocations (OS protocol launches) do not require
    // register-protocol.mjs to be present — that was the Windows crash.
    const { installProtocolHandler, uninstallLegacyBridge } = await import(
      './register-protocol.mjs'
    )
    await uninstallLegacyBridge()
    if (process.platform === 'darwin') {
      const { startMacOsBridgeServer } = await import('./open-bridge.mjs')
      await startMacOsBridgeServer()
      console.log('[devspec-open-handler] macOS: localhost bridge fallback active')
    } else {
      const result = await installProtocolHandler(path.join(DEVSPEC_DIR, 'devspec-handler.cmd'))
      console.log('[devspec-open-handler] devspec:// protocol registered')
      // Linux returns what actually happened. Report it: a scheme owned by
      // another app is the difference between "registered" and "will work".
      if (result?.repaired?.length) {
        console.log(
          `[devspec-open-handler] cleared a conflicting devspec:// association in ${result.repaired.join(', ')}`,
        )
      }
      if (result && result.ok === false) {
        console.warn(
          `[devspec-open-handler] WARNING: devspec:// is still owned by ${result.owner} — ` +
            'run `xdg-mime default devspec-protocol.desktop x-scheme-handler/devspec`, ' +
            'and clear any remembered choice in your desktop settings.',
        )
      }
    }
    console.log(`[devspec-open-handler] installed to ${INSTALLED_HANDLER}`)
    return
  }

  const urlFlagIdx = args.indexOf('--url')
  if (urlFlagIdx >= 0 && args[urlFlagIdx + 1]) {
    await runFromUrlArg(args[urlFlagIdx + 1])
    return
  }

  // Windows passes the URL as the sole argument (registry "%1")
  const positional = args.find((a) => a.startsWith('devspec:'))
  if (positional) {
    await runFromUrlArg(positional)
    return
  }

  if (args.includes('--help')) {
    console.log(`Usage:
  open-handler.mjs --install
  open-handler.mjs --url "devspec://open?..."
  open-handler.mjs "devspec://open?..."`)
    return
  }

  console.error('[devspec-open-handler] no URL provided')
  process.exitCode = 1
}

void main()
