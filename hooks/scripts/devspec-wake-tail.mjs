#!/usr/bin/env node
/**
 * Cursor Connect wake tail — never-exiting stdout follow of the host-owned
 * wake file. The host's Remote workflow may use it as a notify-only background
 * Shell; its wake filter includes owner messages, question answers/dismissals,
 * session end and automation dispatch. Host follow (wait --follow) writes the file; this
 * process only prints new bytes so Cursor can notify the chat after turn_ended.
 *
 * What it prints is what Cursor shows the agent as one background command output, so
 * one print holds whole wakes only, and only as many as fit Cursor's rules on one
 * output together (`wakesForOneOutput`, hook-context-budget.mjs). Wakes that do not
 * fit wait for the next print, one poll later; none is ever split or dropped.
 *
 * Does not consume the inbox. Do not pass --from-end.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureWakeFile, splitWakes } from './devspec-wake-file.mjs'
import { wakesForOneOutput } from './hook-context-budget.mjs'
import { isDirectRun } from './is-direct-run.mjs'

const POLL_MS = 250

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file' || a === '--wake-file' || a === '--wake_file') out.file = argv[++i]
  }
  return out
}

/**
 * What one print hands Cursor from `text`, the wake-file text not printed yet: the
 * whole wakes at its start that fit one output together (`wakesForOneOutput`), or ''
 * when no wake is whole yet. The rest waits for the next print.
 * @param {string} text
 * @param {{ settled?: boolean }} [opts]
 */
export function nextOutput(text, { settled = false } = {}) {
  const { wakes } = splitWakes(text, { settled })
  return wakes.length > 0 ? wakesForOneOutput(wakes).text : ''
}

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = args.file ? path.resolve(String(args.file)) : ''
  if (!file) {
    process.stderr.write('devspec-wake-tail: missing --file\n')
    process.exit(2)
  }
  ensureWakeFile(file)
  let offset = 0
  let lastSize = -1
  process.stderr.write(`devspec-wake-tail: watching ${file}\n`)

  const poll = () => {
    const size = fileSize(file)
    if (size < offset) offset = 0
    // The file has stopped growing since the last poll: lines a wait older than the
    // wake boundary wrote are whole by now.
    const settled = size === lastSize
    lastSize = size
    if (size <= offset) return
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - offset)
      fs.readSync(fd, buf, 0, buf.length, offset)
      const output = nextOutput(buf.toString('utf8'), { settled })
      if (output) {
        offset += Buffer.byteLength(output)
        process.stdout.write(output)
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  poll()
  setInterval(poll, POLL_MS)
}

if (isDirectRun(import.meta.url)) {
  void main().catch((e) => {
    process.stderr.write(`devspec-wake-tail: ${e.message}\n`)
    process.exit(1)
  })
}
