/**
 * Tell DevSpec which model Cursor is running, so the Agents page shows it even when
 * the agent is not in a session (item cc47378e).
 *
 * Cursor hands every hook the selected model (`model`, plus `model_id` and
 * `model_params` when it has them; https://cursor.com/docs/agent/hooks). However,
 * cursor-agent captures the startup model once into its tool-hook factory, so after
 * a mid-conversation model switch every tool hook (`postToolUse`, `beforeShellExecution`,
 * etc.) keeps sending the frozen initial model, whereas live turn/thought hooks
 * (`beforeSubmitPrompt`, `afterAgentThought`, `stop`) and Cursor's own SQLite chat
 * store (`~/.cursor/chats/<md5(cwd)>/<conversation_id>/store.db`, `meta.key='0'`
 * `lastUsedModel`) carry the active model (item c2ddefb6).
 *
 * We therefore:
 *  - treat live turn/thought hooks as authoritative (`_source: 'hook_live'`),
 *  - consult Cursor's local chat store (`_source: 'chat_store'`) on tool hooks and polls,
 *  - never let a stale tool hook (`_source: 'tool_hook'`) overwrite a live-hook or
 *    chat-store model, while keeping tool hooks as the initial fallback when no live
 *    source is available.
 *
 * `_source` is local bookkeeping only and is stripped before returning `agent_stats`.
 *
 * This plugin owns its copy (decision 1d06cdc6); the report shape is the server's
 * `agent_stats` v1, the same one Pi, Claude Code and OpenCode send.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const CURSOR_CHATS_DIR = path.join(os.homedir(), '.cursor', 'chats')

/** The levels `agent_stats.thinkingLevel` accepts. Anything else is sent as null, or the server drops the whole report. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Cursor model_params ids that carry reasoning/effort level across providers (Anthropic, Gemini, Grok, GPT). */
const EFFORT_PARAM_IDS = new Set(['effort', 'thinking', 'reasoning_effort', 'reasoning'])

/** Cursor routes every model itself, so the route it reports under is Cursor. */
const PROVIDER = 'cursor'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_CONVERSATION_ID_RE = /^[a-zA-Z0-9._-]+$/
const HEX_RE = /^[0-9a-f]+$/i

const require = createRequire(import.meta.url)
let sqliteLoaded = false
let cachedDatabaseSync = null

function loadDatabaseSync() {
  if (sqliteLoaded) return cachedDatabaseSync
  sqliteLoaded = true
  try {
    const mod = require('node:sqlite')
    cachedDatabaseSync = typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null
  } catch {
    cachedDatabaseSync = null
  }
  return cachedDatabaseSync
}

/** Cache resolved `store.db` paths per `(chatsDir, cwd, conversationId)` to avoid directory scans on every poll. */
const chatStorePathCache = new Map()

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeConversationId(value) {
  const id = text(value)
  if (!id || id === '.' || id === '..' || !SAFE_CONVERSATION_ID_RE.test(id)) return null
  return id
}

function md5Hex(value) {
  return crypto.createHash('md5').update(value).digest('hex')
}

function findChatStorePath(conversationId, { cwd, chatsDir = CURSOR_CHATS_DIR } = {}) {
  const id = safeConversationId(conversationId)
  if (!id || !chatsDir) return null

  const normalizedCwd = text(cwd)
  const cacheKey = `${chatsDir}\0${normalizedCwd || ''}\0${id}`
  const cached = chatStorePathCache.get(cacheKey)
  if (cached) {
    try {
      if (fs.existsSync(cached)) return cached
    } catch {
      /* re-resolve */
    }
    chatStorePathCache.delete(cacheKey)
  }

  // Fast path: Cursor keys chat folders by md5(workspace cwd).
  if (normalizedCwd) {
    const candidates = new Set([normalizedCwd])
    try {
      candidates.add(path.resolve(normalizedCwd))
    } catch {
      /* ignore */
    }
    for (const dir of candidates) {
      const direct = path.join(chatsDir, md5Hex(dir), id, 'store.db')
      try {
        if (fs.existsSync(direct)) {
          chatStorePathCache.set(cacheKey, direct)
          return direct
        }
      } catch {
        /* continue */
      }
    }
  }

  // Fallback scan when cwd was omitted, symlinked, or started from a different directory.
  try {
    const entries = fs.readdirSync(chatsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(chatsDir, entry.name, id, 'store.db')
      try {
        if (fs.existsSync(candidate)) {
          chatStorePathCache.set(cacheKey, candidate)
          return candidate
        }
      } catch {
        /* continue */
      }
    }
  } catch {
    return null
  }
  return null
}

function decodeMetaJson(raw) {
  let str = null
  if (typeof raw === 'string') {
    str = raw.trim()
  } else if (raw instanceof Uint8Array) {
    str = Buffer.from(raw).toString('utf8').trim()
  }
  if (!str) return null
  try {
    if (str.startsWith('{')) return JSON.parse(str)
    if (str.length % 2 === 0 && HEX_RE.test(str)) {
      return JSON.parse(Buffer.from(str, 'hex').toString('utf8'))
    }
  } catch {
    return null
  }
  return null
}

function effectiveStoreMtimeMs(dbPath) {
  let mtimeMs = 0
  try {
    mtimeMs = Math.max(mtimeMs, fs.statSync(dbPath).mtimeMs || 0)
  } catch {
    /* ignore */
  }
  try {
    mtimeMs = Math.max(mtimeMs, fs.statSync(`${dbPath}-wal`).mtimeMs || 0)
  } catch {
    /* WAL may not exist */
  }
  return mtimeMs
}

/**
 * Read the live `lastUsedModel` Cursor wrote to its local SQLite chat store on turn start.
 * Never throws; returns `{ model, mtimeMs }` or `null` when unavailable or unreadable.
 */
export function readCursorChatModel(conversationId, { cwd, chatsDir = CURSOR_CHATS_DIR } = {}) {
  const dbPath = findChatStorePath(conversationId, { cwd, chatsDir })
  if (!dbPath) return null
  const DatabaseSync = loadDatabaseSync()
  if (!DatabaseSync) return null
  let db = null
  try {
    const mtimeMs = effectiveStoreMtimeMs(dbPath)
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 100 })
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get()
    const meta = decodeMetaJson(row?.value)
    const model = text(meta?.lastUsedModel)
    if (!model) return null
    return { model, mtimeMs }
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

export function telemetryPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.telemetry.json`)
}

function buildReport(id, thinkingLevel, atIso, source) {
  const report = {
    v: 1,
    model: { provider: PROVIDER, id },
    thinkingLevel: THINKING_LEVELS.has(thinkingLevel) ? thinkingLevel : null,
    context: null,
    turn: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 },
    session: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 },
    at: atIso,
  }
  if (source) report._source = source
  return report
}

function toWireReport(raw) {
  if (!raw || raw.v !== 1) return null
  const id = text(raw?.model?.id)
  if (!id) return null
  const provider = text(raw?.model?.provider) ?? PROVIDER
  return {
    v: 1,
    model: { provider, id },
    thinkingLevel: THINKING_LEVELS.has(raw.thinkingLevel) ? raw.thinkingLevel : null,
    context: raw.context ?? null,
    turn: raw.turn ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 },
    session: raw.session ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 },
    at: text(raw.at) ?? new Date().toISOString(),
  }
}

function readStoredTelemetry(connectionId, dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(telemetryPath(connectionId, dir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function preservedThinkingLevel(existing, modelId) {
  if (!existing || existing?.model?.id !== modelId) return null
  return THINKING_LEVELS.has(existing.thinkingLevel) ? existing.thinkingLevel : null
}

/**
 * The runtime report a hook's stdin describes, or null when it names no model.
 * `model_id` is preferred to the legacy `model` slug when both are present.
 */
export function runtimeReportFromHookInput(input, now = new Date()) {
  if (!input || typeof input !== 'object') return null
  const id = text(input.model_id) ?? text(input.model)
  if (!id) return null
  const params = Array.isArray(input.model_params) ? input.model_params : []
  const effort = params.find((p) => p && EFFORT_PARAM_IDS.has(p.id) && THINKING_LEVELS.has(text(p.value)))
  return buildReport(id, effort ? text(effort.value) : null, now.toISOString())
}

/**
 * Write the report for this connection from a hook's raw stdin. Never throws: a
 * missing model or an unwritable file just means no report, and the hook carries on.
 *
 * When `authoritative` is true (`beforeSubmitPrompt`, `afterAgentThought`, `stop`),
 * the hook's live model always wins (`_source: 'hook_live'`).
 * Otherwise (tool hooks whose payload is frozen at startup in cursor-agent), we first
 * check Cursor's local SQLite chat store (`_source: 'chat_store'`) and never overwrite
 * an existing live-hook or chat-store report with a stale tool-hook model.
 */
export function recordRuntimeReport(
  connectionId,
  rawHookInput,
  {
    dir = CONNECTIONS_DIR,
    now = new Date(),
    authoritative = false,
    conversationId,
    cwd,
    chatsDir = CURSOR_CHATS_DIR,
  } = {},
) {
  if (!UUID_RE.test(String(connectionId || ''))) return false
  try {
    const parsed = JSON.parse(rawHookInput || '{}')
    if (!parsed || typeof parsed !== 'object') return false

    if (authoritative) {
      const report = runtimeReportFromHookInput(parsed, now)
      if (!report) return false
      fs.writeFileSync(telemetryPath(connectionId, dir), JSON.stringify({ ...report, _source: 'hook_live' }), { mode: 0o600 })
      return true
    }

    const existing = readStoredTelemetry(connectionId, dir)
    const existingSource = text(existing?._source)
    const existingAtMs = existing?.at ? Date.parse(existing.at) : NaN
    const convId = text(conversationId) ?? text(parsed.conversation_id) ?? text(parsed.session_id)

    if (convId) {
      const store = readCursorChatModel(convId, { cwd, chatsDir })
      if (store?.model) {
        if (existingSource === 'hook_live' && Number.isFinite(existingAtMs) && existingAtMs > store.mtimeMs) {
          return false
        }
        const report = buildReport(
          store.model,
          preservedThinkingLevel(existing, store.model),
          now.toISOString(),
          'chat_store',
        )
        fs.writeFileSync(telemetryPath(connectionId, dir), JSON.stringify(report), { mode: 0o600 })
        return true
      }
    }

    if (existing && text(existing?.model?.id) && (existingSource === 'hook_live' || existingSource === 'chat_store')) {
      return false
    }

    const report = runtimeReportFromHookInput(parsed, now)
    if (!report) return false
    fs.writeFileSync(telemetryPath(connectionId, dir), JSON.stringify({ ...report, _source: 'tool_hook' }), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** `{ agent_stats }` for a poll's arguments, or `{}` when this connection has no report yet. */
export function agentStatsArgs(
  connectionId,
  { dir = CONNECTIONS_DIR, localId, cwd, chatsDir = CURSOR_CHATS_DIR } = {},
) {
  if (!UUID_RE.test(String(connectionId || ''))) return {}
  try {
    const existing = readStoredTelemetry(connectionId, dir)
    const convId = text(localId)
    if (convId) {
      const store = readCursorChatModel(convId, { cwd, chatsDir })
      if (store?.model) {
        const existingSource = text(existing?._source)
        const existingAtMs = existing?.at ? Date.parse(existing.at) : NaN
        const hookLiveIsNewer =
          existingSource === 'hook_live' && Number.isFinite(existingAtMs) && existingAtMs > store.mtimeMs
        if (!hookLiveIsNewer) {
          const atIso =
            Number.isFinite(store.mtimeMs) && store.mtimeMs > 0
              ? new Date(store.mtimeMs).toISOString()
              : new Date().toISOString()
          return {
            agent_stats: toWireReport(
              buildReport(store.model, preservedThinkingLevel(existing, store.model), atIso),
            ),
          }
        }
      }
    }
    const wire = toWireReport(existing)
    return wire ? { agent_stats: wire } : {}
  } catch {
    return {}
  }
}
