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
 * @param {string} handlerCmdPath  Path to devspec-handler.cmd (installed copy).
 *   WINDOWS ONLY — it is a cmd.exe batch file. Linux resolves its own POSIX
 *   launcher; handing this path to installLinux is the bug fixed in this file.
 */
export async function installProtocolHandler(handlerCmdPath) {
  if (process.platform === 'win32') {
    await installWindows(handlerCmdPath)
    return
  }
  if (process.platform === 'linux') {
    await installLinux()
    return
  }
}

async function installWindows(handlerCmdPath) {
  // Route through the .vbs wrapper (sibling file, same install dir) via
  // wscript.exe //B instead of invoking devspec-handler.cmd directly — a
  // .cmd file always needs a console host, which briefly flashed a visible
  // window on every single devspec:// launch. wscript.exe has no console of
  // its own and WshShell.Run(...,0,...) launches the real handler hidden.
  // Quote %1 so URLs with & / ? survive cmd.exe parsing (Windows protocol invoke).
  const vbsPath = handlerCmdPath.replace(/\.cmd$/i, '.vbs')
  const command = `wscript.exe //B ${quoteWin(vbsPath)} "%1"`
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

/**
 * Escape one `Exec=` argument per the Desktop Entry spec: wrap in double quotes
 * and backslash-escape the characters that stay special inside them. Field codes
 * (`%u`) go OUTSIDE the quotes — a quoted "%u" is not expanded.
 */
export function quoteDesktopExecArg(value) {
  return `"${String(value).replace(/(["`$\\])/g, '\\$1')}"`
}

/**
 * Build the `Exec=` value. Prefers the POSIX launcher (devspec-handler.sh);
 * falls back to invoking node + the handler directly for an older install tree
 * that predates the launcher. Always ends in `%u` — without it the handler is
 * invoked with no URL and exits.
 */
export function linuxDesktopExecLine({ launcherPath, nodeBin, handlerPath }) {
  if (launcherPath) return `${quoteDesktopExecArg(launcherPath)} %u`
  return `${quoteDesktopExecArg(nodeBin)} ${quoteDesktopExecArg(handlerPath)} %u`
}

/**
 * The `.desktop` entry that claims devspec://.
 *
 * `Terminal=false` is deliberate and correct: the handler spawns its own
 * terminal emulator for CLI launches (see the emulator ladder in
 * open-handler-core.mjs), so asking the DE for one too would nest two windows.
 * `NoDisplay=true` keeps a protocol handler out of application menus.
 */
export function buildLinuxDesktopEntry(execLine) {
  return `[Desktop Entry]
Name=DevSpec Protocol Handler
Comment=Open DevSpec work in Cursor, OpenCode or Pi
Exec=${execLine}
Type=Application
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/devspec;
`
}

/**
 * Absolute node path for the launcher-less fallback Exec line.
 *
 * Bare `node` is not safe in a `.desktop` Exec: the launch inherits the desktop
 * *session* PATH, which never includes a version-manager node. `process.execPath`
 * is only usable when this process really is node — inside the Cursor extension
 * host it is the Cursor binary, which would open the editor instead of running
 * the handler.
 */
async function resolveLinuxNodeBin() {
  if (/^node(js)?$/i.test(path.basename(process.execPath))) return process.execPath
  try {
    const { stdout } = await execFileAsync('which', ['node'])
    const found = stdout.trim()
    if (found) return found
  } catch {
    // fall through to bare `node`
  }
  return 'node'
}

/**
 * Claim devspec:// on Linux.
 *
 * Takes no argument on purpose. It used to receive devspec-handler.cmd and, when
 * that file existed (always — it is installed on every platform), wrote it
 * straight into `Exec=`. That pointed the desktop entry at a cmd.exe batch file
 * (`sh: @echo: not found` … `Syntax error`) and carried no `%u`, so every Linux
 * devspec:// launch died before the handler ever saw a URL. The only correct
 * branch was the fallback, which could not be reached.
 */
async function installLinux() {
  const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications')
  await fs.mkdir(desktopDir, { recursive: true })
  const desktopPath = path.join(desktopDir, 'devspec-protocol.desktop')

  const launcherPath = path.join(DEVSPEC_DIR, 'devspec-handler.sh')
  const hasLauncher = await pathExists(launcherPath)
  if (hasLauncher) {
    // A .desktop Exec must be executable; npm/vsix packing does not always
    // preserve the mode bit.
    try {
      await fs.chmod(launcherPath, 0o755)
    } catch {
      // best-effort
    }
  }

  const execLine = linuxDesktopExecLine({
    launcherPath: hasLauncher ? launcherPath : null,
    nodeBin: hasLauncher ? null : await resolveLinuxNodeBin(),
    handlerPath: path.join(DEVSPEC_DIR, 'open-handler.mjs'),
  })

  await fs.writeFile(desktopPath, buildLinuxDesktopEntry(execLine), 'utf8')
  try {
    await execFileAsync('update-desktop-database', [desktopDir])
  } catch {
    // optional on some distros
  }
  // update-desktop-database only refreshes mimeinfo.cache ("can handle").
  // Desktops that read mimeapps.list [Default Applications] need the default
  // set explicitly, which is what xdg-mime writes.
  try {
    await execFileAsync('xdg-mime', [
      'default',
      'devspec-protocol.desktop',
      'x-scheme-handler/devspec',
    ])
  } catch {
    // xdg-utils not installed — mimeinfo.cache still resolves on most DEs
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
