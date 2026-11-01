#!/usr/bin/env node
/**
 * Cursor Connect wake tail — never-exiting stdout follow of the host-owned
 * wake file. The host's Remote workflow may use it as a notify-only background
 * Shell; its wake filter includes owner messages, question answers/dismissals,
 * session end and automation dispatch. Host follow (wait --follow) writes the file; this
 * process only prints new bytes so Cursor can notify the chat after turn_ended.
 *
 * Does not consume the inbox. Do not pass --from-end.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureWakeFile } from './devspec-wake-file.mjs'
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
  process.stderr.write(`devspec-wake-tail: watching ${file}\n`)

  const poll = () => {
    const size = fileSize(file)
    if (size < offset) offset = 0
    if (size <= offset) return
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - offset)
      fs.readSync(fd, buf, 0, buf.length, offset)
      offset = size
      if (buf.length) process.stdout.write(buf)
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
