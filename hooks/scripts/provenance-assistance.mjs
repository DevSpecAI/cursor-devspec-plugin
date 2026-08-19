#!/usr/bin/env node
/**
 * Capability-honest commit provenance assistance for Cursor.
 *
 * Cursor's generic preToolUse hook can inspect and update structured Shell
 * input. That is the only enforcement surface used here. File edits are never
 * denied, arbitrary shell is never classified, and every opaque/unsupported
 * commit form fails open to DevSpec ingestion and analyzer recovery.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HOOK_MODES = new Set(['preToolUse', 'postToolUse', 'afterMCPExecution'])
export const TERMINAL_WORK_VERBS = new Set(['record_implementation', 'release_work_item', 'fail_work_item'])

const FULL_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FULL_PROJECT_ID = new RegExp(`^${FULL_UUID}$`, 'i')
const VALID_REFERENCE = new RegExp(`\\[devspec:(${FULL_UUID})\\]`, 'gi')
const REFERENCE_START = /\[devspec\s*:/gi
const EDIT_TOOLS = new Set(['write', 'edit', 'applypatch', 'apply_patch', 'delete'])
const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const HISTORY_OPTIONS = ['--amend', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--no-edit', '--reset-author']

export const AMBIGUOUS_REFERENCE_MESSAGE =
  'DevSpec commit provenance: this readable commit message has malformed or multiple DevSpec references. Keep exactly one full [devspec:<uuid>] reference and retry. Nothing else is blocked.'

export const MULTIPLE_CLAIMS_MESSAGE =
  'DevSpec commit provenance: this Cursor conversation has multiple active DevSpec claims, so the plugin will not guess which reference belongs in the commit. Keep exactly one correct [devspec:<uuid>] reference in the message and retry. Nothing else is blocked.'

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function cleanUuid(value) {
  const text = cleanString(value)
  return text && FULL_PROJECT_ID.test(text) ? text.toLowerCase() : null
}

export function parseHookInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(String(raw || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function resolveConversationId(data, env = process.env) {
  return (
    cleanString(data?.conversation_id) ||
    cleanString(data?.conversationId) ||
    cleanString(data?.session_id) ||
    cleanString(env.CURSOR_CONVERSATION_ID)
  )
}

export function defaultStateRoot(env = process.env) {
  return cleanString(env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR) ||
    path.join(os.homedir(), '.devspec', 'cursor-provenance-state')
}

export function statePathForConversation(conversationId, stateRoot = defaultStateRoot()) {
  const digest = crypto.createHash('sha256').update(conversationId).digest('hex')
  return path.join(stateRoot, `${digest}.json`)
}

function emptyState(conversationId) {
  return {
    conversation_id: conversationId,
    active_claims: [],
    nudged_projects: [],
    pending_stamps: {},
  }
}

export function readConversationState(conversationId, stateRoot = defaultStateRoot()) {
  if (!conversationId) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(statePathForConversation(conversationId, stateRoot), 'utf8'))
    if (parsed?.conversation_id !== conversationId) return emptyState(conversationId)
    return {
      ...emptyState(conversationId),
      ...parsed,
      active_claims: Array.isArray(parsed.active_claims)
        ? parsed.active_claims.map((claim) => typeof claim === 'string'
          ? { id: cleanUuid(claim), project_id: null, observed_at: null }
          : { id: cleanUuid(claim?.id), project_id: cleanUuid(claim?.project_id), observed_at: cleanString(claim?.observed_at) })
          .filter((claim) => claim.id && claim.project_id && claim.observed_at)
        : [],
      nudged_projects: Array.isArray(parsed.nudged_projects) ? parsed.nudged_projects.filter((id) => typeof id === 'string') : [],
      pending_stamps: parsed.pending_stamps && typeof parsed.pending_stamps === 'object' && !Array.isArray(parsed.pending_stamps)
        ? parsed.pending_stamps
        : {},
    }
  } catch {
    return emptyState(conversationId)
  }
}

export function writeConversationState(conversationId, value, stateRoot = defaultStateRoot()) {
  const target = statePathForConversation(conversationId, stateRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ ...emptyState(conversationId), ...value, conversation_id: conversationId }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, target)
}

function candidateCwd(data) {
  return cleanString(data?.cwd) || cleanString(data?.working_directory) || process.cwd()
}

function editTargetDirectory(data) {
  const input = parseJsonObject(data?.tool_input ?? data?.toolInput) || data?.tool_input || data?.toolInput
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const file = cleanString(input.path) || cleanString(input.file_path) || cleanString(input.filePath) ||
    cleanString(input.target_file) || cleanString(input.targetFile)
  if (!file) return null
  const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(candidateCwd(data), file)
  return path.dirname(target)
}

function nearestExistingDirectory(start) {
  let current = path.resolve(start)
  while (true) {
    try {
      if (fs.statSync(current).isDirectory()) return current
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}

function gitTopLevel(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim()
  } catch {
    return null
  }
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function gitMainWorktree(cwd) {
  try {
    const output = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    })
    const first = output.split('\0').find((field) => field.startsWith('worktree '))
    return first ? path.resolve(first.slice('worktree '.length)) : null
  } catch {
    return null
  }
}

function walkForPin(start, repoRoot, home) {
  let current = path.resolve(start)
  const boundedByHome = isInside(current, home)
  while (true) {
    if (boundedByHome && current === home) return { pin: null, invalid: false }
    const pinPath = path.join(current, '.devspec', 'project.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(pinPath, 'utf8'))
      const projectId = cleanUuid(parsed?.project_id)
      return projectId
        ? { pin: { projectId, path: pinPath }, invalid: false }
        : { pin: null, invalid: true }
    } catch (error) {
      if (error?.code !== 'ENOENT') return { pin: null, invalid: true }
    }
    if (current === repoRoot) return { pin: null, invalid: false }
    const parent = path.dirname(current)
    if (parent === current || path.relative(repoRoot, parent).startsWith('..')) return { pin: null, invalid: false }
    current = parent
  }
}

/** Resolve the nearest positive project pin without ever consulting ~/.devspec. */
export function findProjectPin(start, options = {}) {
  const home = path.resolve(options.home || os.homedir())
  const initial = path.resolve(start || process.cwd())
  const repoRoot = path.resolve(options.repoRoot || gitTopLevel(nearestExistingDirectory(initial)) || initial)
  const local = walkForPin(initial, repoRoot, home)
  if (local.pin || local.invalid) return local.pin

  // A local untracked pin lives only in the main checkout. Linked worktrees
  // share repository identity but not untracked files, so consult Git's
  // documented worktree metadata rather than parsing .git indirection files.
  const main = options.mainWorktree === null
    ? null
    : path.resolve(options.mainWorktree || gitMainWorktree(initial) || repoRoot)
  if (!main || main === repoRoot) return null
  return walkForPin(main, main, home).pin
}

function lexCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 32_768 || /[\r\n]/.test(command)) return null
  const tokens = []
  let index = 0
  while (index < command.length) {
    while (/\s/.test(command[index] || '')) index += 1
    if (index >= command.length) break
    if (command.startsWith('&&', index)) {
      tokens.push({ value: '&&', raw: '&&', start: index, end: index + 2, quote: null })
      index += 2
      continue
    }
    if (command.startsWith('||', index) || ';|<>\n\r'.includes(command[index]) || command[index] === '`') return null
    const start = index
    const quote = command[index] === "'" || command[index] === '"' ? command[index] : null
    if (quote) {
      index += 1
      let value = ''
      while (index < command.length && command[index] !== quote) {
        const char = command[index]
        if (quote === '"' && char === '\\') {
          if (index + 1 >= command.length) return null
          value += char + command[index + 1]
          index += 2
          continue
        }
        value += char
        index += 1
      }
      if (command[index] !== quote) return null
      index += 1
      tokens.push({ value, raw: command.slice(start, index), start, end: index, quote })
      continue
    }
    while (index < command.length && !/\s/.test(command[index]) && !';&|<>`'.includes(command[index])) index += 1
    if (index === start) return null
    tokens.push({ value: command.slice(start, index), raw: command.slice(start, index), start, end: index, quote: null })
  }
  return tokens.length ? tokens : null
}

function safeLiteralPath(token) {
  if (!token || !token.value || token.value.startsWith('-')) return false
  if (token.quote === null && (token.value.includes('\\') || token.value.includes('~') || /[*?\[\]{}()!]/.test(token.value))) return false
  return !/[\n\r`$]/.test(token.value)
}

function resolvedDirectory(base, token) {
  if (!safeLiteralPath(token)) return null
  return path.resolve(base, token.value)
}

/**
 * Read only the narrow commit shapes authorized by ADR 71c23b46:
 *   git commit ... -m '<message>'
 *   cd <single-path> && git commit ... -m '<message>'
 *   git -C <path> commit ... -m '<message>'
 */
export function parseReadableCommit(command, cwd = process.cwd()) {
  const tokens = lexCommand(command)
  if (!tokens || tokens.some((token) => /%[^%]+%/.test(token.value)) ||
    tokens.some((token) => token.quote !== "'" && /[$`!]/.test(token.value)) ||
    tokens.some((token) => token.quote === null && /[\\*?\[\]{}()!~]/.test(token.value))) return null
  let index = 0
  let targetCwd = path.resolve(cwd)

  if (tokens[index]?.value === 'cd') {
    const directory = resolvedDirectory(targetCwd, tokens[index + 1])
    if (!directory || tokens[index + 2]?.value !== '&&') return null
    targetCwd = directory
    index += 3
  }

  if (tokens[index]?.value !== 'git') return null
  index += 1
  if (tokens[index]?.value === '-C') {
    const directory = resolvedDirectory(targetCwd, tokens[index + 1])
    if (!directory) return null
    targetCwd = directory
    index += 2
  }
  if (tokens[index]?.value !== 'commit') return null
  index += 1

  const rest = tokens.slice(index)
  if (!rest.length || rest.some((token) => token.value === '&&')) return null
  if (rest.some((token) => {
    if (token.value === '-C' || token.value === '-c' || /^-[Cc].+/.test(token.value)) return true
    if (!token.value.startsWith('--')) return false
    const optionName = token.value.split('=', 1)[0]
    return HISTORY_OPTIONS.some((option) => option.startsWith(optionName))
  })) return null

  let messageToken = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].value !== '-m' && rest[i].value !== '--message') continue
    if (messageToken || !rest[i + 1]?.quote) return null
    messageToken = rest[i + 1]
    i += 1
  }
  if (!messageToken) return null
  if (messageToken.quote === '"' && /[`$]/.test(messageToken.value)) return null

  return {
    command,
    targetCwd,
    message: messageToken.value,
    insertAt: messageToken.end - 1,
  }
}

export function inspectReferences(message) {
  const valid = [...String(message || '').matchAll(VALID_REFERENCE)].map((match) => match[1].toLowerCase())
  const starts = [...String(message || '').matchAll(REFERENCE_START)]
  return {
    valid,
    malformedOrAmbiguous: starts.length !== valid.length || valid.length > 1,
  }
}

export function appendReference(parsed, actionItemId) {
  return `${parsed.command.slice(0, parsed.insertAt)}${parsed.message ? ' ' : ''}[devspec:${actionItemId}]${parsed.command.slice(parsed.insertAt)}`
}

function toolFields(data) {
  const lowerName = (cleanString(data?.tool_name) || cleanString(data?.toolName) || '').toLowerCase()
  const known = ['claim_work_item', ...TERMINAL_WORK_VERBS]
  const verb = known.find((candidate) => lowerName === candidate || lowerName === `devspec__${candidate}` || lowerName === `devspec.${candidate}`) || ''
  return { verb, isDevspec: Boolean(verb) }
}

function claimedItemId(args) {
  return cleanUuid(args?.action_item_id) || cleanUuid(args?.actionItemId) || cleanUuid(args?.id)
}

function resultItemValues(result) {
  return [
    result?.id,
    result?.action_item_id,
    result?.action_item?.id,
    result?.work_item?.id,
    result?.item?.id,
    result?.data?.id,
    result?.data?.action_item_id,
    result?.data?.action_item?.id,
    result?.result?.id,
    result?.result?.action_item_id,
    result?.result?.action_item?.id,
  ].map(cleanString).filter(Boolean)
}

function resultProjectValues(result) {
  return [
    result?.project_id,
    result?.action_item?.project_id,
    result?.work_item?.project_id,
    result?.item?.project_id,
    result?.data?.project_id,
    result?.data?.action_item?.project_id,
    result?.result?.project_id,
    result?.result?.action_item?.project_id,
  ].map(cleanString).filter(Boolean)
}

function normalizeStatus(value) {
  return cleanString(value)?.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_') || null
}

function structuredStatuses(result) {
  return [
    result?.status,
    result?.outcome,
    result?.claim_status,
    result?.lifecycle,
    result?.action_item?.status,
    result?.action_item?.state,
    result?.action_item?.lifecycle,
    result?.work_item?.status,
    result?.item?.status,
    result?.data?.status,
    result?.data?.lifecycle,
    result?.result?.status,
    result?.result?.lifecycle,
  ].map(normalizeStatus).filter(Boolean)
}

function hasOuterFailure(result) {
  const status = normalizeStatus(result?.status)
  return !result || result.success === false || result.ok === false || result.isError === true ||
    result.claim_success === false || result.claimed === false || result.not_claimed === true ||
    Boolean(result.error) || Boolean(result.conflict) || Boolean(result.possible_conflict) ||
    ['error', 'failure', 'conflict', 'possible_conflict', 'not_claimed', 'unclaimed'].includes(status)
}

export function parseMcpExecution(data) {
  const { verb, isDevspec } = toolFields(data)
  const args = parseJsonObject(data?.tool_input ?? data?.toolInput) || {}
  const resultPresent = Object.hasOwn(data || {}, 'result_json') || Object.hasOwn(data || {}, 'resultJson')
  const result = parseJsonObject(data?.result_json ?? data?.resultJson)
  const requestedId = claimedItemId(args)
  if (!isDevspec || !resultPresent || hasOuterFailure(result)) return { verb, args, successful: false, actionItemId: requestedId, projectId: null }
  const rawProjects = resultProjectValues(result)
  const returnedProjects = rawProjects.map(cleanUuid).filter(Boolean)
  const projectId = rawProjects.length === returnedProjects.length && returnedProjects.length &&
    returnedProjects.every((id) => id === returnedProjects[0]) ? returnedProjects[0] : null
  const requestedProjectValue = cleanString(args?.project_id) || cleanString(args?.pinned_project_id)
  const requestedProject = cleanUuid(requestedProjectValue)
  const projectAgrees = !requestedProjectValue || Boolean(requestedProject && requestedProject === projectId)
  if (verb === 'claim_work_item') {
    const rawReturned = resultItemValues(result)
    const returned = rawReturned.map(cleanUuid).filter(Boolean)
    const successful = result.claim_success === true && Boolean(requestedId) && Boolean(projectId) && projectAgrees &&
      rawReturned.length === returned.length && returned.length > 0 && returned.every((id) => id === requestedId)
    return { verb, args, successful, actionItemId: requestedId, projectId }
  }
  const allowedStatuses = {
    record_implementation: new Set(['success', 'ok', 'implemented', 'done']),
    release_work_item: new Set(['success', 'ok', 'released', 'idle', 'open']),
    fail_work_item: new Set(['success', 'ok', 'failed']),
  }[verb] || new Set()
  const successful = result.success === true || result.ok === true ||
    (verb === 'record_implementation' && result.implemented === true) ||
    (verb === 'release_work_item' && result.released === true) ||
    (verb === 'fail_work_item' && result.failed === true) ||
    structuredStatuses(result).some((status) => allowedStatuses.has(status))
  return { verb, args, successful, actionItemId: requestedId, projectId }
}

function withinObservationWindow(value, now) {
  const at = Date.parse(value || '')
  return Number.isFinite(at) && at <= now && now - at <= STATE_MAX_AGE_MS
}

function prunePending(pending, now = Date.now()) {
  return Object.fromEntries(Object.entries(pending || {}).filter(([, value]) => withinObservationWindow(value?.at, now)))
}

function pruneClaims(claims, now = Date.now()) {
  return (claims || []).filter((claim) => claim.id && claim.project_id && withinObservationWindow(claim.observed_at, now))
}

export function handleHook(mode, data, options = {}) {
  const env = options.env || process.env
  const conversationId = options.conversationId || resolveConversationId(data, env)
  if (!conversationId) return null
  const stateRoot = options.stateRoot || defaultStateRoot(env)
  const state = readConversationState(conversationId, stateRoot)
  const nowMs = options.nowMs || Date.now()
  state.pending_stamps = prunePending(state.pending_stamps, nowMs)
  state.active_claims = pruneClaims(state.active_claims, nowMs)

  if (mode === 'afterMCPExecution') {
    const call = parseMcpExecution(data)
    if (!call.successful || !call.actionItemId) return null
    if (call.verb === 'claim_work_item') {
      state.active_claims = [
        ...state.active_claims.filter((claim) => claim.id !== call.actionItemId),
        { id: call.actionItemId, project_id: call.projectId, observed_at: new Date(nowMs).toISOString() },
      ]
    }
    if (TERMINAL_WORK_VERBS.has(call.verb)) {
      state.active_claims = state.active_claims.filter((claim) => claim.id !== call.actionItemId)
    }
    writeConversationState(conversationId, state, stateRoot)
    return null
  }

  if (mode === 'preToolUse') {
    const toolName = (cleanString(data?.tool_name) || '').toLowerCase()
    if (toolName !== 'shell') return null
    const toolInput = parseJsonObject(data?.tool_input ?? data?.toolInput) || data?.tool_input || data?.toolInput
    if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null
    const commandKey = typeof toolInput.command === 'string' ? 'command' : typeof toolInput.cmd === 'string' ? 'cmd' : null
    if (!commandKey) return null
    const parsed = parseReadableCommit(toolInput[commandKey], candidateCwd(data))
    const pin = parsed ? findProjectPin(parsed.targetCwd, options.pinOptions) : null
    if (!parsed || !pin) return null
    const eligibleClaims = state.active_claims.filter((claim) => claim.project_id === pin.projectId)

    const refs = inspectReferences(parsed.message)
    if (refs.valid.length === 1 && !refs.malformedOrAmbiguous) return null
    if (refs.malformedOrAmbiguous) {
      return { permission: 'deny', user_message: AMBIGUOUS_REFERENCE_MESSAGE, agent_message: AMBIGUOUS_REFERENCE_MESSAGE }
    }
    if (eligibleClaims.length === 0) return null
    if (eligibleClaims.length > 1) {
      return { permission: 'deny', user_message: MULTIPLE_CLAIMS_MESSAGE, agent_message: MULTIPLE_CLAIMS_MESSAGE }
    }

    const actionItemId = eligibleClaims[0].id
    const updatedCommand = appendReference(parsed, actionItemId)
    const toolUseId = cleanString(data?.tool_use_id) || cleanString(data?.toolUseId)
    if (toolUseId) {
      state.pending_stamps[toolUseId] = { action_item_id: actionItemId, at: new Date(nowMs).toISOString() }
      writeConversationState(conversationId, state, stateRoot)
    }
    return {
      permission: 'allow',
      updated_input: { ...toolInput, [commandKey]: updatedCommand },
      agent_message: `DevSpec appended [devspec:${actionItemId}] to this commit message.`,
    }
  }

  if (mode === 'postToolUse') {
    const toolUseId = cleanString(data?.tool_use_id) || cleanString(data?.toolUseId)
    if (toolUseId && state.pending_stamps[toolUseId]) {
      const item = state.pending_stamps[toolUseId].action_item_id
      delete state.pending_stamps[toolUseId]
      writeConversationState(conversationId, state, stateRoot)
      return { additional_context: `DevSpec appended [devspec:${item}] to the commit message that just ran.` }
    }

    const toolName = (cleanString(data?.tool_name) || '').toLowerCase()
    if (!EDIT_TOOLS.has(toolName)) return null
    const targetDirectory = editTargetDirectory(data)
    if (!targetDirectory) return null
    const pin = findProjectPin(targetDirectory, options.pinOptions)
    if (!pin || state.active_claims.some((claim) => claim.project_id === pin.projectId) || state.nudged_projects.includes(pin.projectId)) return null
    state.nudged_projects.push(pin.projectId)
    writeConversationState(conversationId, state, stateRoot)
    return {
      additional_context:
        `DevSpec provenance note: this edit already completed in project ${pin.projectId}, and this Cursor conversation has no observed active claim. ` +
        'Continue working—do not stop or retry. When practical, search/reuse/create and claim the smallest covering item; commit linkage and server reconciliation remain authoritative.',
    }
  }

  return null
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main() {
  try {
    const mode = String(process.argv[2] || '')
    if (!HOOK_MODES.has(mode)) return
    const output = handleHook(mode, parseHookInput(readStdin()))
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (error) {
    // Cursor's hook-failure default is host-dependent. Make provenance outages
    // explicitly fail open: diagnostics go to stderr and no decision is emitted.
    process.stderr.write(`[devspec-provenance] hook failed open: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
