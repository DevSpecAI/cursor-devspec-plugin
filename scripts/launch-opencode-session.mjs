#!/usr/bin/env node
/**
 * OpenCode cold-launch session runner (runs invisibly — no terminal window).
 *
 * Real bug found live-testing: a one-shot `opencode run ...` process exits
 * the instant it finishes the connect handshake, leaving nothing running to
 * ever receive a dispatched message afterward — the whole point of remote
 * control. Proven fix: start a persistent `opencode serve` (detached,
 * survives after this script exits), then run the connect/message command
 * against it via `opencode run --attach <server-url> ...` — verified live
 * twice that the server keeps responding after the attached run command
 * completes.
 *
 * This trades a visible interactive terminal (Cursor's cold-launch opens
 * one) for "definitely works, no window" — an explicit choice, not an
 * oversight: getting slash-command expansion to work reliably in OpenCode's
 * interactive TUI mode could not be cleanly verified in the time available.
 *
 * Real bug found live-testing (round 2): `stdio: 'ignore'` alone does NOT
 * suppress the window. spawnAgent's Windows fallback wraps the binary in a
 * `cmd.exe /c` call, and cmd.exe opens its own visible console regardless of
 * the child's stdio config — both the server and client spawns below popped
 * a titled cmd window that then sat there (blank, or showing the server's
 * startup banner) until closed. `windowsHide: true` on both spawn calls is
 * required in addition to `stdio: 'ignore'`.
 *
 * Real bug found live-testing (round 3): windowsHide + stdio:'ignore' still
 * wasn't enough on its own — one window (server's startup banner) stayed
 * visible. Root cause was one level deeper, in launch-cli-session.mjs's
 * resolveWindowsAgentInvocation: OpenCode ships a real compiled `.exe`, not
 * an npm `.cmd`/`.ps1` shim trio like Cursor's `agent` — so it fell through
 * to the generic cmd.exe-wrapping fallback (built for shim binaries that
 * genuinely need a shell) instead of being spawned directly. That extra,
 * unnecessary cmd.exe hop is what the visible console was attached to.
 * Fixed by adding a dedicated `.exe` → direct-spawn branch there.
 *
 * Real bug found live-testing (round 4 — active incident, not just a delivery
 * gap): the plugin's local state file (src/remote-control.ts's `stateFile`)
 * is keyed ONLY by project directory, on the assumption of at most one live
 * OpenCode remote-control connection per directory. Nothing enforced that
 * assumption here — repeated cold-launches against the same project left
 * MULTIPLE `opencode serve` processes running concurrently, all sharing and
 * clobbering that one state file. Observed live: two servers stomping on
 * each other's `sessionId` caused replies to mirror into a stale, already
 * -archived session neither owner was watching, in a tight repost loop
 * (every ~4s) — total silence on the real session, an actively growing mess
 * on the wrong one. Fixed by enforcing a single server per directory: kill
 * any previously-recorded server (tracked via a PID sidecar file) and clear
 * its now-stale state before starting a fresh one.
 *
 * Real bug found live-testing (round 6 — this is why round 4's fix kept
 * failing): the pid recorded and killed was spawn()'s own return value —
 * the PowerShell wrapper's pid (the powershell-ps1 invocation path in
 * launch-cli-session.mjs). Confirmed live with Get-CimInstance: that
 * wrapper process exits shortly after launching opencode.exe (opencode.ps1
 * runs it as a foreground `&` call, but control returns to PowerShell well
 * before the long-running `serve` command actually finishes) — leaving the
 * REAL server process alive as an orphan, completely untracked by the pid
 * we recorded. Every subsequent launch's killExistingServer call was
 * therefore always targeting an already-dead pid, a guaranteed no-op, while
 * the actual server piled up untouched — explaining why Axiom showed 3-4x
 * the expected single-server call volume sustained for 20+ minutes. Fixed
 * by looking up the ACTUAL listening pid for the port via `netstat -ano`
 * once the server responds, and recording THAT instead of spawn()'s pid.
 *
 * Invoked by open-handler-core when tool=opencode:
 *   node launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>]
 */
import { execFile, spawnSync } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { spawnAgent } from './launch-cli-session.mjs'

const execFileAsync = promisify(execFile)

/**
 * Find the pid actually LISTENING on 127.0.0.1:<port> right now, via
 * `netstat -ano`. See the "round 6" note above for why this — not
 * spawn()'s own returned pid — is the only reliable thing to track and
 * kill later.
 */
async function findListeningPid(port) {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'])
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(`127.0.0.1:${port}`) || !line.includes('LISTENING')) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[parts.length - 1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {
    // best-effort — fall back to spawn()'s pid if this fails
  }
  return null
}

/** Same key scheme as the plugin's own state file (src/remote-control.ts `stateFile`) — colocated, not shared code (different repos). */
function directoryKey(folder) {
  return Buffer.from(path.resolve(folder)).toString('base64url').slice(0, 32)
}

function remoteControlDir() {
  return path.join(os.homedir(), '.devspec', 'opencode-remote-control')
}

function serverPidFile(folder) {
  return path.join(remoteControlDir(), `${directoryKey(folder)}.server.pid`)
}

function remoteControlStateFile(folder) {
  return path.join(remoteControlDir(), `${directoryKey(folder)}.json`)
}

/**
 * Enforce single-server-per-directory: kill whatever `opencode serve` this
 * directory's PID file points at (if it's still alive) before starting a
 * new one, and clear the now-stale connection state alongside it — carrying
 * a dead server's sessionId/connectionId into a fresh one is exactly how the
 * cross-connection state clobbering above happened.
 */
async function killExistingServer(folder) {
  const pidFile = serverPidFile(folder)
  let pid
  try {
    pid = Number((await fsPromises.readFile(pidFile, 'utf8')).trim())
  } catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 0) return
  await log(`killing prior server pid=${pid}`)
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // already dead — fine
  }
  try {
    await fsPromises.unlink(remoteControlStateFile(folder))
  } catch {
    // already gone
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--folder' && argv[i + 1]) out.folder = argv[++i]
    else if (a === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i]
    else if (a === '--opencode' && argv[i + 1]) out.opencode = argv[++i]
    else if (a === '--model' && argv[i + 1]) out.model = argv[++i]
  }
  return out
}

/**
 * Build the `opencode run` argv (minus `--attach`, added by the caller) for a
 * prompt body + optional model.
 *
 * `opencode run` does NOT expand a leading "/command args" string the way
 * typing it into the interactive TUI does — passed as a plain positional
 * message, the model just receives it as inert text (observed live: it
 * tried to execute "/devspec.remote --session <uuid>" as a shell path).
 * The registered-command form needs the dedicated --command flag instead,
 * with "--" so yargs doesn't reparse the command's own flags (e.g.
 * --session) as opencode's own.
 * @param {string} promptBody
 * @param {string} [model]
 * @returns {string[]}
 */
export function buildOpencodeRunArgs(promptBody, model) {
  const runArgs = ['run']
  const trimmedModel = typeof model === 'string' ? model.trim() : ''
  if (trimmedModel) runArgs.push('--model', trimmedModel)

  const slashCommand = promptBody.match(/^\/([a-zA-Z0-9_.-]+)\s*(.*)$/s)
  if (slashCommand) {
    const [, commandName, commandArgs] = slashCommand
    runArgs.push('--command', commandName)
    if (commandArgs) runArgs.push('--', commandArgs)
  } else {
    runArgs.push(promptBody)
  }
  return runArgs
}

const LAUNCHER_LOG_FILE = path.join(remoteControlDir(), 'launcher.log')

/**
 * This script is always spawned with `stdio: 'ignore'` by open-handler-core
 * (it must run invisibly — see the file header) — which means every
 * console.log/console.error call before this fix went straight into the
 * void. Real gap found live-testing: a launch that failed partway through
 * (server never came up, client errored) left zero trace anywhere, making
 * it indistinguishable from "still working, just slow." Persist the same
 * milestones to a log file instead of only stdio.
 */
async function log(line) {
  try {
    await fsPromises.mkdir(path.dirname(LAUNCHER_LOG_FILE), { recursive: true })
    await fsPromises.appendFile(LAUNCHER_LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // best-effort — logging must never be why a launch fails
  }
}

/** Find a free TCP port on localhost for the headless server to listen on. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      srv.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
    srv.on('error', reject)
  })
}

/** Poll the server's OpenAPI doc endpoint until it responds (or timeout). */
async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/doc`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await log(`start argv=${JSON.stringify(process.argv.slice(2))}`)
  if (!args.folder || !args.promptFile) {
    console.error(
      'Usage: launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>]',
    )
    await log('missing --folder or --prompt-file')
    process.exitCode = 1
    return
  }

  const opencodeBin = args.opencode || 'opencode'
  let promptBody
  try {
    promptBody = (await fsPromises.readFile(args.promptFile, 'utf8')).trim()
  } catch (err) {
    console.error(`[devspec-opencode] could not read prompt file: ${err}`)
    await log(`could not read prompt file: ${err}`)
    process.exitCode = 1
    return
  }

  // Must happen before spawning the new server — see "round 4" note above.
  // A second live server for the same directory means two processes racing
  // to write the same state file, not two independent connections.
  await killExistingServer(args.folder)
  await log(`opencodeBin=${opencodeBin} folder=${args.folder}`)

  const port = await findFreePort()
  await log(`chose port ${port}`)

  // Real bug found live-testing (round 5): `detached: true` reliably killed
  // the server on Windows before it ever bound its port — empty log, no
  // process, no trace, regardless of stdio/windowsHide. Isolated by testing
  // spawn configurations directly: `detached` alone (no windowsHide) failed
  // the same way, and `windowsHide` alone (no `detached`) started and
  // listened fine every time. Most likely cause: Windows' DETACHED_PROCESS
  // creation flag (what `detached` maps to) means NO console at all, which
  // conflicts with something PowerShell's own startup expects — whereas
  // `windowsHide` maps to CREATE_NO_WINDOW, a console that merely isn't
  // shown, which PowerShell tolerates fine.
  //
  // `detached` was never actually necessary for survival here: Windows does
  // NOT kill a child process when its parent exits (unlike POSIX process
  // groups) unless something explicitly ties their lifetimes together (e.g.
  // a Job Object with kill-on-close, which a launch from Explorer/browser
  // via the devspec:// protocol handler does not create). `windowsHide` +
  // `stdio: 'ignore'` alone is sufficient for both invisibility and survival.
  const server = spawnAgent(opencodeBin, ['serve', '--port', String(port)], {
    cwd: args.folder,
    stdio: 'ignore',
    windowsHide: true,
  })
  server.unref()
  await log(`spawned server pid=${server.pid ?? 'unknown'}`)

  const ready = await waitForServer(port)
  await log(`waitForServer ready=${ready}`)
  if (!ready) {
    console.error(`[devspec-opencode] server did not come up on port ${port} in time`)
    process.exitCode = 1
    return
  }

  // Record the REAL listening pid, not spawn()'s own return value — see the
  // "round 6" note at the top of this file for why that pid goes stale
  // almost immediately and made every prior kill-existing-server attempt a
  // silent no-op.
  const realPid = (await findListeningPid(port)) ?? server.pid
  await log(`recording server pid=${realPid ?? 'unknown'} (spawn returned ${server.pid ?? 'unknown'})`)
  if (realPid) {
    await fsPromises.mkdir(remoteControlDir(), { recursive: true })
    await fsPromises.writeFile(serverPidFile(args.folder), String(realPid), 'utf8')
  }

  const attachUrl = `http://127.0.0.1:${port}`
  const runArgs = buildOpencodeRunArgs(promptBody, args.model)
  runArgs.splice(1, 0, '--attach', attachUrl)

  console.log(
    `[devspec-opencode] Server up on ${attachUrl}; sending connect message (model=${args.model || 'auto'})`,
  )
  await log(`spawning client runArgs=${JSON.stringify(runArgs)}`)
  // Reuses the Windows-safe invocation logic built for Cursor's `agent` binary
  // (prefer a sibling .ps1 over wrapping a .cmd in `cmd /c`, which loses the
  // real console TTY and flash-closes the window) — the same shim-resolution
  // problem applies to any npm-installed .cmd binary, not just Cursor's.
  const client = spawnAgent(opencodeBin, runArgs, {
    cwd: args.folder,
    stdio: 'ignore',
    windowsHide: true,
  })
  await log(`spawned client pid=${client.pid ?? 'unknown'}`)

  client.on('error', (err) => {
    console.error(`[devspec-opencode] failed to run connect command: ${err}`)
    void log(`client error event: ${err}`)
    process.exitCode = 1
  })

  client.on('exit', (code, signal) => {
    // The persistent server (spawned above, detached+unref'd) is intentionally
    // left running — only the one-shot connect/message client call is done.
    void log(`client exit code=${code} signal=${signal}`)
    if (signal) {
      process.exitCode = 1
      return
    }
    process.exitCode = code ?? 0
  })
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('launch-opencode-session.mjs') ||
    process.argv[1].endsWith('launch-opencode-session.js'))

if (isDirectRun) {
  void main()
}
