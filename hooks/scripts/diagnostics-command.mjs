#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { activeDiagnostics, appendDiagnostic, diagnosticStatus, exportDiagnostics, isDiagnosticId, markDiagnosticSource, pruneDiagnostics, startDiagnostics, stopDiagnostics } from './local-diagnostics.mjs'
import { resolveAgentTranscriptPath } from './work-trail.mjs'
import { loadState } from './mirror-turn.mjs'

function parse(argv) {
  const out = { action: argv[0] || 'status' }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--connection' && argv[i + 1]) out.connectionId = argv[++i]
    else if (argv[i] === '--minutes' && argv[i + 1]) out.minutes = Number(argv[++i])
    else if (out.action === 'observe' && argv[i] === '--run' && isDiagnosticId(argv[i + 1])) out.runId = argv[++i]
    else throw Error('Use start|status|stop|export [--connection UUID] [--minutes 1–60]')
  }
  if (!out.connectionId) {
    const localId = process.env.CURSOR_CONVERSATION_ID
    if (isDiagnosticId(localId)) out.connectionId = loadState(localId)?.connection_id
  }
  if (!isDiagnosticId(out.connectionId)) throw Error('Specify --connection with the exact connection UUID, or run in its native Cursor conversation')
  return out
}

/** Metadata-only observation of the selected chat's existing transcript. Never
 * read/copy raw trace contents. Host MCP logs are inventoried, not misrepresented
 * as measurements; their per-call timings remain unknown until safely observed.
 */
export async function observeDiagnostics(connectionId, runId) {
  let run = activeDiagnostics({ connectionId })
  if (!run || run.meta.runId !== runId) return
  const logRoot = process.platform === 'win32' ? process.env.APPDATA && path.join(process.env.APPDATA, 'Cursor', 'logs') :
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'logs') : path.join(os.homedir(), '.config', 'Cursor', 'logs')
  markDiagnosticSource(run, 'host_mcp_trace', logRoot && fs.existsSync(logRoot) ? 'present_not_imported' : 'unavailable')
  let transcript = null, lastSize = null, lastMtime = null, tick = 0
  while ((run = activeDiagnostics({ connectionId })) && run.meta.runId === runId) {
    if (!transcript && tick++ % 10 === 0 && run.meta.local_id) transcript = resolveAgentTranscriptPath(run.meta.local_id)
    if (transcript) {
      try {
        const stat = fs.lstatSync(transcript)
        if (!stat.isFile() || stat.isSymbolicLink()) { transcript = null; continue }
        if (stat.size !== lastSize || stat.mtimeMs !== lastMtime) {
          appendDiagnostic({ connectionId }, { kind: 'transcript', phase: 'observed', source: 'transcript_observer', outcome: 'unknown', available: true, file_bytes: stat.size, ...(lastSize !== null && stat.size >= lastSize ? { appended_bytes: stat.size - lastSize } : {}) }, { runId })
          markDiagnosticSource(run, 'transcript', 'available')
          lastSize = stat.size; lastMtime = stat.mtimeMs
        }
      } catch { transcript = null; markDiagnosticSource(run, 'transcript', 'unavailable') }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

export async function diagnosticsCommand(argv) {
  const args = parse(argv)
  pruneDiagnostics()
  if (args.action === 'observe') { await observeDiagnostics(args.connectionId, args.runId); return null }
  if (args.action === 'start') {
    const run = startDiagnostics(args.connectionId, { ...(args.minutes !== undefined ? { minutes: args.minutes } : {}) })
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'observe', '--connection', args.connectionId, '--run', run.meta.runId], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
    const observer = await new Promise(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)) })
    child.unref()
    if (!observer) markDiagnosticSource(run, 'transcript', 'unavailable')
    return { active: true, directory: run.dir, events: path.join(run.dir, 'events.jsonl'), expiresAt: new Date(run.meta.expiresAt).toISOString(), observer, uploads: false }
  }
  if (args.action === 'stop') { const result = stopDiagnostics(args.connectionId); return { active: false, directory: result.dir, uploads: false } }
  if (args.action === 'export') return { export: exportDiagnostics(args.connectionId), uploads: false, instruction: 'Review this local export before explicitly sharing it. No file has been uploaded.' }
  if (args.action === 'status') {
    const status = diagnosticStatus(args.connectionId)
    return { active: status.active, directory: status.dir, expiresAt: status.meta ? new Date(status.meta.expiresAt).toISOString() : null, observedEvents: status.meta?.count || 0, uploads: false }
  }
  throw Error('Unknown diagnostic action')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  diagnosticsCommand(process.argv.slice(2)).then(result => { if (result) process.stdout.write(JSON.stringify(result) + '\n') })
    .catch(() => { process.stderr.write('Cursor diagnostics could not complete. Check the command, connection, existing active run and private directory permissions.\n'); process.exitCode = 1 })
}
