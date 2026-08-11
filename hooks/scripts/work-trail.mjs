#!/usr/bin/env node
/**
 * Pure helpers for Cursor remote-control work-trail mirroring.
 * Shape mirrors OpenCode's work-trail constants/throttle (conceptually only —
 * no file sync across plugin repos).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TRAIL_MAX_CHARS = 100_000
export const TRAIL_POST_MIN_GAP_MS = 1_000
export const TRAIL_TRIM_NOTICE = '… earlier output trimmed …\n'
export const TRAIL_SEED_TEXT = 'Working…'
export const TRAIL_PART_MAX_CHARS = 8_000

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

export function trailStatePath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.trail.json`)
}

export function readTrailState(connectionId) {
  if (!connectionId) return null
  try {
    const raw = JSON.parse(fs.readFileSync(trailStatePath(connectionId), 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

export function writeTrailState(connectionId, state) {
  if (!connectionId) return
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
  fs.writeFileSync(trailStatePath(connectionId), JSON.stringify(state), { mode: 0o600 })
}

export function clearTrailState(connectionId) {
  if (!connectionId) return
  try {
    fs.rmSync(trailStatePath(connectionId), { force: true })
  } catch {
    /* ignore */
  }
}

/** @param {string} text */
export function hashPostedContent(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 32)
}

/** @param {string} trail */
export function clampTrail(trail) {
  const s = String(trail || '')
  if (s.length <= TRAIL_MAX_CHARS) return s
  const keep = TRAIL_MAX_CHARS - TRAIL_TRIM_NOTICE.length
  return TRAIL_TRIM_NOTICE + s.slice(s.length - keep)
}

/** @param {string} text @param {number} [max] */
export function elideLongOutput(text, max = TRAIL_PART_MAX_CHARS) {
  const s = String(text || '')
  if (s.length <= max) return s
  const head = Math.floor(max / 2) - 20
  const tail = max - head - 40
  return `${s.slice(0, head)}\n… (${s.length - head - tail} chars elided) …\n${s.slice(-tail)}`
}

/**
 * @param {{
 *   trail: string
 *   trailHash: string
 *   lastPostedTrailHash?: string | null
 *   lastPostedAt?: number | null
 *   now: number
 *   minGapMs?: number
 *   force?: boolean
 *   seed?: boolean
 * }} input
 */
export function shouldPostTrail(input) {
  const isEmpty = !String(input.trail || '').trim()
  if (isEmpty && !(input.force && input.seed)) return false
  if (input.trailHash === (input.lastPostedTrailHash ?? null)) return false
  if (input.force) return true
  const gap = input.minGapMs ?? TRAIL_POST_MIN_GAP_MS
  const last = input.lastPostedAt ?? null
  if (last == null) return true
  return input.now - last >= gap
}

/**
 * Append a rendered part (or replace with seed) and decide whether to post.
 * @returns {{ trail: string, shouldPost: boolean, force: boolean, seed: boolean, nextState: object } | null}
 */
export function advanceTrailState({
  prev,
  part,
  mode,
  now = Date.now(),
  transcriptText = null,
}) {
  const force = mode === 'seed'
  const seed = mode === 'seed'
  let cumulative = typeof prev?.cumulative === 'string' ? prev.cumulative : ''

  if (seed) {
    if (cumulative.trim() && cumulative.trim() !== TRAIL_SEED_TEXT) return null
    cumulative = TRAIL_SEED_TEXT
  } else if (typeof transcriptText === 'string' && transcriptText.trim()) {
    cumulative = serializeTranscriptJsonl(transcriptText)
  } else if (part) {
    if (cumulative === TRAIL_SEED_TEXT) cumulative = ''
    cumulative = clampTrail(cumulative ? `${cumulative}\n\n${part}` : part)
  } else {
    return null
  }

  const trailHash = hashPostedContent(cumulative)
  const gate = shouldPostTrail({
    trail: cumulative,
    trailHash,
    lastPostedTrailHash: prev?.lastPostedHash ?? null,
    lastPostedAt: prev?.lastPostedAt ?? null,
    now,
    force,
    seed,
  })

  return {
    trail: cumulative,
    shouldPost: gate,
    force,
    seed,
    nextState: {
      cumulative,
      lastPostedHash: gate ? trailHash : prev?.lastPostedHash ?? null,
      lastPostedAt: gate ? now : prev?.lastPostedAt ?? null,
      updatedAt: now,
    },
  }
}

/** True when this hook event is our own DevSpec post (would recurse). */
export function isDevspecPostSessionTool(hookEvent) {
  const name = String(hookEvent?.tool_name || hookEvent?.toolName || '').toLowerCase()
  const input = hookEvent?.tool_input ?? hookEvent?.toolInput ?? hookEvent
  const blob = typeof input === 'string' ? input : JSON.stringify(input ?? {})
  if (name.includes('post_session_message')) return true
  if (/mcp:.*post_session_message/i.test(name)) return true
  if (
    (name === 'callmcptool' || name.includes('mcp')) &&
    /post_session_message/i.test(blob)
  ) {
    return true
  }
  return false
}

/**
 * Render one Cursor hook payload into a trail block, or null to skip.
 * @param {string} mode
 * @param {Record<string, unknown>} data
 */
export function renderHookTrailPart(mode, data) {
  if (!data || typeof data !== 'object') return null
  if (isDevspecPostSessionTool(data)) return null

  if (mode === 'seed') return TRAIL_SEED_TEXT

  if (mode === 'postToolUse' || mode === 'preToolUse') {
    const tool = String(data.tool_name || data.toolName || 'tool')
    const input = summarizeInput(data.tool_input ?? data.toolInput)
    const header = `$ ${tool}${input ? ` ${input}` : ''}`
    if (mode === 'preToolUse') return `${header}\n  … running`
    const out = data.tool_output ?? data.toolOutput
    const outText =
      typeof out === 'string' ? out : out != null ? JSON.stringify(out, null, 0) : ''
    const duration =
      typeof data.duration === 'number' ? ` (${Math.round(data.duration)}ms)` : ''
    if (!outText.trim()) return `${header}${duration}`
    return `${header}${duration}\n${elideLongOutput(outText.trim())}`
  }

  if (mode === 'postToolUseFailure') {
    const tool = String(data.tool_name || data.toolName || 'tool')
    const err = String(data.error_message || data.errorMessage || data.failure_type || 'failed')
    return `$ ${tool}\n  ✗ ${err}`
  }

  if (mode === 'afterShellExecution' || mode === 'beforeShellExecution') {
    const cmd = String(data.command || '').trim() || '(shell)'
    if (mode === 'beforeShellExecution') return `$ ${cmd}\n  … running`
    const output = String(data.output || '')
    const duration =
      typeof data.duration === 'number' ? ` (${Math.round(data.duration)}ms)` : ''
    if (!output.trim()) return `$ ${cmd}${duration}`
    return `$ ${cmd}${duration}\n${elideLongOutput(output.trim())}`
  }

  if (mode === 'afterMCPExecution' || mode === 'beforeMCPExecution') {
    const tool = String(data.tool_name || data.toolName || 'mcp')
    if (isDevspecPostSessionTool({ tool_name: tool, tool_input: data.tool_input })) return null
    const input = summarizeInput(data.tool_input ?? data.toolInput)
    const header = `$ MCP:${tool}${input ? ` ${input}` : ''}`
    if (mode === 'beforeMCPExecution') return `${header}\n  … running`
    const result = data.result_json ?? data.resultJson ?? data.result
    const outText =
      typeof result === 'string' ? result : result != null ? JSON.stringify(result) : ''
    if (!outText.trim()) return header
    return `${header}\n${elideLongOutput(outText.trim())}`
  }

  if (mode === 'afterFileEdit') {
    const filePath = String(data.file_path || data.filePath || 'file')
    const edits = Array.isArray(data.edits) ? data.edits.length : 0
    return `✎ ${filePath}${edits ? ` (${edits} edit${edits === 1 ? '' : 's'})` : ''}`
  }

  if (mode === 'afterAgentThought') {
    const text = String(data.text || '').trim()
    return text ? `» ${elideLongOutput(text, 4_000)}` : null
  }

  return null
}

/**
 * Best-effort serialize of Cursor agent-transcript JSONL (conversation dump).
 * Keeps assistant tool_use + short text; skips user prompts.
 * @param {string} jsonl
 * @param {number} [maxChars]
 */
export function serializeTranscriptJsonl(jsonl, maxChars = TRAIL_MAX_CHARS) {
  const lines = String(jsonl || '').split(/\r?\n/).filter(Boolean)
  const blocks = []
  for (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const role = row?.role || row?.message?.role
    if (role !== 'assistant') continue
    const content = row?.message?.content ?? row?.content
    const parts = Array.isArray(content) ? content : []
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'tool_use') {
        const name = String(part.name || 'tool')
        const input = summarizeInput(part.input)
        blocks.push(`$ ${name}${input ? ` ${input}` : ''}`)
      } else if (part.type === 'text') {
        const text = String(part.text || '').trim()
        // Skip long model narration — trail is activity, answer is separate.
        if (text && text.length <= 280 && !text.includes('━━━ DevSpec Remote Control')) {
          blocks.push(text)
        }
      }
    }
  }
  return clampTrail(blocks.join('\n\n').trimEnd()).slice(0, maxChars)
}

/** @param {unknown} input */
function summarizeInput(input) {
  if (input == null) return ''
  if (typeof input === 'string') {
    const t = input.trim().replace(/\s+/g, ' ')
    return t.length > 120 ? `${t.slice(0, 117)}…` : t
  }
  if (typeof input !== 'object') return String(input)
  const obj = /** @type {Record<string, unknown>} */ (input)
  const preferred =
    obj.command ?? obj.path ?? obj.file_path ?? obj.query ?? obj.pattern ?? obj.toolName ?? obj.name
  if (typeof preferred === 'string' && preferred.trim()) {
    const t = preferred.trim().replace(/\s+/g, ' ')
    return t.length > 120 ? `${t.slice(0, 117)}…` : t
  }
  try {
    const raw = JSON.stringify(obj)
    return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
  } catch {
    return ''
  }
}
