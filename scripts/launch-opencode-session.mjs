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
 * Invoked by open-handler-core when tool=opencode:
 *   node launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>]
 */
import fsPromises from 'node:fs/promises'
import net from 'node:net'
import { spawnAgent } from './launch-cli-session.mjs'

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
  if (!args.folder || !args.promptFile) {
    console.error(
      'Usage: launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>]',
    )
    process.exitCode = 1
    return
  }

  const opencodeBin = args.opencode || 'opencode'
  let promptBody
  try {
    promptBody = (await fsPromises.readFile(args.promptFile, 'utf8')).trim()
  } catch (err) {
    console.error(`[devspec-opencode] could not read prompt file: ${err}`)
    process.exitCode = 1
    return
  }

  const port = await findFreePort()

  // Detached + unref'd so this server outlives launch-opencode-session.mjs
  // itself — it's the thing that must keep running for remote control to
  // ever deliver anything after this script exits. windowsHide is required
  // here even with stdio:'ignore' — spawnAgent's Windows fallback wraps the
  // binary in a `cmd.exe /c` invocation, and cmd.exe opens its own visible
  // console window unless explicitly told not to (confirmed live: without
  // this, both the server and the client below popped a visible cmd window).
  const server = spawnAgent(opencodeBin, ['serve', '--port', String(port)], {
    cwd: args.folder,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  })
  server.unref()

  const ready = await waitForServer(port)
  if (!ready) {
    console.error(`[devspec-opencode] server did not come up on port ${port} in time`)
    process.exitCode = 1
    return
  }

  const attachUrl = `http://127.0.0.1:${port}`
  const runArgs = buildOpencodeRunArgs(promptBody, args.model)
  runArgs.splice(1, 0, '--attach', attachUrl)

  console.log(
    `[devspec-opencode] Server up on ${attachUrl}; sending connect message (model=${args.model || 'auto'})`,
  )
  // Reuses the Windows-safe invocation logic built for Cursor's `agent` binary
  // (prefer a sibling .ps1 over wrapping a .cmd in `cmd /c`, which loses the
  // real console TTY and flash-closes the window) — the same shim-resolution
  // problem applies to any npm-installed .cmd binary, not just Cursor's.
  const client = spawnAgent(opencodeBin, runArgs, {
    cwd: args.folder,
    stdio: 'ignore',
    windowsHide: true,
  })

  client.on('error', (err) => {
    console.error(`[devspec-opencode] failed to run connect command: ${err}`)
    process.exitCode = 1
  })

  client.on('exit', (code, signal) => {
    // The persistent server (spawned above, detached+unref'd) is intentionally
    // left running — only the one-shot connect/message client call is done.
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
