/**
 * Register devspec:// as an OS protocol handler (Windows + Linux).
 * macOS uses localhost bridge fallback until a signed .app bundle ships.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DEVSPEC_DIR, DEVSPEC_LOCAL_OPEN_PORT } from './open-handler-core.mjs'

const execFileAsync = promisify(execFile)

function quoteWin(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} handlerCmdPath  Path to devspec-handler.cmd (installed copy)
 */
export async function installProtocolHandler(handlerCmdPath) {
  if (process.platform === 'win32') {
    await installWindows(handlerCmdPath)
    return
  }
  if (process.platform === 'linux') {
    await installLinux(handlerCmdPath)
    return
  }
}

async function installWindows(handlerCmdPath) {
  const command = `${quoteWin(handlerCmdPath)} %1`
  const keys = [
    ['HKCU\\Software\\Classes\\devspec', '/ve', '/d', 'URL:DevSpec Protocol', '/f'],
    ['HKCU\\Software\\Classes\\devspec', '/v', 'URL Protocol', '/d', '', '/f'],
    [
      'HKCU\\Software\\Classes\\devspec\\shell\\open\\command',
      '/ve',
      '/d',
      command,
      '/f',
    ],
  ]
  for (const args of keys) {
    await execFileAsync('reg', ['add', ...args], { windowsHide: true })
  }
}

async function installLinux(handlerScript) {
  const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications')
  await fs.mkdir(desktopDir, { recursive: true })
  const desktopPath = path.join(desktopDir, 'devspec-protocol.desktop')
  const nodeHandler = path.join(DEVSPEC_DIR, 'open-handler.mjs')
  const execLine = (await pathExists(handlerScript))
    ? handlerScript
    : `node ${nodeHandler} %u`

  const desktop = `[Desktop Entry]
Name=DevSpec Protocol Handler
Comment=Open DevSpec action items in Cursor
Exec=${execLine}
Type=Application
Terminal=false
MimeType=x-scheme-handler/devspec;
`
  await fs.writeFile(desktopPath, desktop, 'utf8')
  try {
    await execFileAsync('update-desktop-database', [desktopDir])
  } catch {
    // optional on some distros
  }
}

export async function uninstallLegacyBridge() {
  const startupLink = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'DevSpec Open Bridge.cmd',
  )
  try {
    await fs.unlink(startupLink)
  } catch {
    // ignore
  }

  const pidPath = path.join(DEVSPEC_DIR, 'open-bridge.pid')
  try {
    const pid = Number(await fs.readFile(pidPath, 'utf8'))
    if (pid) {
      try {
        process.kill(pid)
      } catch {
        // not running
      }
    }
    await fs.unlink(pidPath)
  } catch {
    // ignore
  }

  if (process.platform === 'win32' || process.platform === 'linux') {
    try {
      await execFileAsync('reg', ['delete', 'HKCU\\Software\\Classes\\devspec', '/f'], {
        windowsHide: true,
      })
    } catch {
      // ignore
    }
  }
}

/** Stop any process listening on the legacy bridge port (best-effort). */
export async function stopLegacyBridgeServer() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true })
      for (const line of stdout.split('\n')) {
        if (!line.includes(`127.0.0.1:${DEVSPEC_LOCAL_OPEN_PORT}`)) continue
        const parts = line.trim().split(/\s+/)
        const pid = Number(parts[parts.length - 1])
        if (pid > 0) {
          try {
            process.kill(pid)
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

export function isProtocolSupportedPlatform() {
  return process.platform === 'win32' || process.platform === 'linux'
}
