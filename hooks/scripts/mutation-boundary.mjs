#!/usr/bin/env node
/**
 * Cursor mutation-boundary hooks.
 *
 * Cursor can deny shell execution before it happens, but exposes native file
 * edits only after they happen. Accordingly this script blocks unsafe shell
 * commands while unclaimed and audits (without pretending to undo) an
 * unclaimed afterFileEdit event.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HOOK_MODES = new Set([
  'beforeShellExecution',
  'afterMCPExecution',
  'afterFileEdit',
])

export const TERMINAL_WORK_VERBS = new Set([
  'record_implementation',
  'release_work_item',
  'fail_work_item',
])

export const CLAIM_WARNING =
  'DevSpec mutation boundary: claim the covering item and retry before making changes; read-only investigation remains available. Follow the canonical implementation contract returned by claim_work_item.'

export const POST_EDIT_WARNING =
  `${CLAIM_WARNING} Cursor reported this edit only after it occurred; the hook did not prevent or revert the edit. Review the edit after claiming the work.`

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

export function resolveConversationId(data, env = process.env) {
  return (
    cleanString(data?.conversation_id) ||
    cleanString(data?.conversationId) ||
    cleanString(env.CURSOR_CONVERSATION_ID)
  )
}

function candidateCwd(data, env) {
  const roots = Array.isArray(data?.workspace_roots) ? data.workspace_roots : []
  const firstRoot = roots
    .map((root) => cleanString(root) || cleanString(root?.path) || cleanString(root?.uri?.fsPath))
    .find(Boolean)
  return (
    cleanString(data?.repo_root) ||
    cleanString(data?.workspace_root) ||
    cleanString(firstRoot) ||
    cleanString(data?.cwd) ||
    cleanString(env.DEVSPEC_REPO_ROOT) ||
    cleanString(env.CURSOR_WORKSPACE_ROOT) ||
    process.cwd()
  )
}

export function resolveRepoRoot(data, env = process.env, gitRoot = null) {
  const cwd = candidateCwd(data, env)
  let root = cleanString(gitRoot)
  if (!root && cwd) {
    try {
      root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim()
    } catch {
      root = cwd
    }
  }
  if (!root) return null
  const normalized = path.resolve(root)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function resolveScope(data, env = process.env, gitRoot = null) {
  const conversationId = resolveConversationId(data, env)
  const repoRoot = resolveRepoRoot(data, env, gitRoot)
  return conversationId && repoRoot ? { conversationId, repoRoot } : null
}

export function defaultStateRoot(env = process.env) {
  return cleanString(env.DEVSPEC_CURSOR_HOOK_STATE_DIR) ||
    path.join(os.homedir(), '.devspec', 'cursor-hook-state')
}

export function statePathForScope(scope, stateRoot = defaultStateRoot()) {
  const digest = crypto
    .createHash('sha256')
    .update(`${scope.conversationId}\0${scope.repoRoot}`)
    .digest('hex')
  return path.join(stateRoot, `${digest}.json`)
}

export function readScopeState(scope, stateRoot = defaultStateRoot()) {
  try {
    const value = JSON.parse(fs.readFileSync(statePathForScope(scope, stateRoot), 'utf8'))
    if (value?.conversation_id !== scope.conversationId || value?.repo_root !== scope.repoRoot) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export function writeScopeState(scope, value, stateRoot = defaultStateRoot()) {
  const target = statePathForScope(scope, stateRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const next = {
    conversation_id: scope.conversationId,
    repo_root: scope.repoRoot,
    ...value,
  }
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, target)
  return next
}

function shellWords(command) {
  const text = String(command || '').trim()
  if (!text || /[\n\r;&|<>`$(){}\\*?\[\]]/.test(text)) return null
  const words = []
  let word = ''
  let quote = null
  let started = false
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      else word += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word)
        word = ''
        started = false
      }
    } else {
      word += char
      started = true
    }
  }
  if (quote) return null
  if (started) words.push(word)
  return words.length ? words : null
}

const LS_OPTIONS = /^-(?:[1AaBbCcdFfghHiklLmNopqRrSsTtUuvwxX]+)$/
const CAT_OPTIONS = new Set(['-A', '-b', '-E', '-n', '-s', '-T', '--number', '--number-nonblank', '--show-all', '--show-ends', '--show-tabs', '--squeeze-blank'])
const HEAD_TAIL_OPTIONS = /^(?:-[cnqv]|-[0-9]+|--(?:bytes|lines)=\+?-?[0-9]+|--quiet|--silent|--verbose)$/
const GIT_STATUS_OPTIONS = /^(?:--short|--porcelain(?:=v[12])?|--branch|--show-stash|--ahead-behind|--no-ahead-behind|--untracked-files=(?:no|normal|all)|-[bsu]+)$/
const GIT_DIFF_OPTIONS = /^(?:--cached|--staged|--stat|--numstat|--shortstat|--name-only|--name-status|--summary|--check|--quiet|--exit-code|--no-ext-diff|--no-textconv|--color(?:=(?:always|never|auto))?|--no-color|-[Uu][0-9]+)$/
const GIT_LOG_OPTIONS = /^(?:--oneline|--decorate(?:=(?:short|full|auto|no))?|--no-decorate|--graph|--all|--branches|--tags|--remotes|--stat|--shortstat|--name-only|--name-status|--no-patch|--no-ext-diff|--no-textconv|--date=(?:relative|iso|iso-strict|short|default|raw|unix)|--format=(?:oneline|short|medium|full|fuller|reference|email|raw|format:.*)|--pretty=(?:oneline|short|medium|full|fuller|reference|email|raw|format:.*)|--max-count=[0-9]+|-[0-9]+)$/
const GIT_REV_PARSE_OPTIONS = /^(?:--show-toplevel|--show-prefix|--show-cdup|--git-dir|--absolute-git-dir|--is-inside-work-tree|--is-bare-repository|--abbrev-ref|--short(?:=[0-9]+)?|--verify|--quiet)$/

function argsArePaths(args) {
  let afterSeparator = false
  for (const arg of args) {
    if (arg === '--') {
      afterSeparator = true
      continue
    }
    if (!afterSeparator && arg.startsWith('-')) return false
  }
  return true
}

function gitReadOnly(words) {
  const subcommand = words[1]
  const args = words.slice(2)
  if (!subcommand) return false
  if (subcommand === 'status') return args.every((arg) => GIT_STATUS_OPTIONS.test(arg))
  if (subcommand === 'diff') {
    return args.includes('--no-ext-diff') &&
      args.includes('--no-textconv') &&
      args.every((arg) => arg === '--' || !arg.startsWith('-') || GIT_DIFF_OPTIONS.test(arg))
  }
  if (subcommand === 'log' || subcommand === 'show') {
    return args.includes('--no-ext-diff') &&
      args.includes('--no-textconv') &&
      args.every((arg) => arg === '--' || !arg.startsWith('-') || GIT_LOG_OPTIONS.test(arg))
  }
  if (subcommand === 'rev-parse') {
    return args.every((arg) => !arg.startsWith('-') || GIT_REV_PARSE_OPTIONS.test(arg))
  }
  if (subcommand === 'branch') return args.length === 1 && args[0] === '--show-current'
  return false
}

function compoundSegments(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16384 || /`|\$\(|[<>]/.test(command)) return null
  const segments = []
  let current = ''
  let quote = null
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (char === quote) quote = null; else current += char; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '&' && command[index + 1] !== '&') return null
    if ((char === '&' || char === '|') && command[index + 1] === char) {
      if (!current.trim()) return null
      segments.push(current.trim()); current = ''; index += 1; continue
    }
    if (char === ';' || char === '\n' || char === '|') {
      if (current.trim()) segments.push(current.trim())
      current = ''; continue
    }
    if (char === '(' || char === ')') return null
    current += char
  }
  if (quote || escaped) return null
  if (current.trim()) segments.push(current.trim())
  return segments.length ? segments : null
}

function compoundWords(segment) {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) =>
    word.length >= 2 && ((word[0] === '"' && word.at(-1) === '"') || (word[0] === "'" && word.at(-1) === "'"))
      ? word.slice(1, -1) : word,
  ) || []
}

function compoundGitReadOnly(args) {
  let index = 0
  if (args[index] === '-C') {
    const target = args[index + 1]
    if (!target || (target.includes('$') && !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(target))) return false
    index += 2
  }
  while (['--no-pager', '--no-optional-locks'].includes(args[index])) index += 1
  const verb = args[index]
  const rest = args.slice(index + 1)
  if (!verb || rest.some((arg) => arg.includes('$') || ['--output', '--ext-diff', '--textconv'].includes(arg) || arg.startsWith('--output='))) return false
  if (['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'grep', 'blame', 'describe', 'for-each-ref', 'cat-file', 'diff-tree', 'diff-index', 'diff-files', 'merge-base', 'shortlog'].includes(verb)) return true
  if (verb === 'branch') return rest.length === 0 || rest.every((arg) => /^(?:-a|--all|-r|--remotes|--list|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--format=|--sort=)/.test(arg))
  if (verb === 'worktree') return rest[0] === 'list'
  if (verb === 'remote') return rest.length === 0 || ['-v', 'show', 'get-url'].includes(rest[0])
  return false
}

/** Every segment of a compound shell inspection must be conservatively read-only. */
export function classifyShellCommand(command) {
  const segments = compoundSegments(command)
  const allowed = Boolean(segments?.every((segment) => {
    const words = compoundWords(segment)
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const assignment = words.shift()
      const name = assignment.slice(0, assignment.indexOf('='))
      const value = assignment.slice(assignment.indexOf('=') + 1)
      if (/^(?:PATH|GIT_|LD_|DYLD_|NODE_OPTIONS|BASH_ENV|ENV|SHELL|IFS)/.test(name) || value.includes('$')) return false
    }
    const program = words.shift()
    if (!program) return true
    if (program === 'git') return compoundGitReadOnly(words)
    if (words.some((arg) => arg.includes('$'))) return false
    if (program === 'find') return !words.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))
    if (program === 'rg') return !words.some((arg) => arg === '--pre' || arg.startsWith('--pre='))
    if (program === 'printf' && words.includes('-v')) return false
    return ['pwd', 'printf', 'echo', 'ls', 'cat', 'head', 'tail', 'grep', 'cut', 'wc', 'stat', 'file', 'readlink', 'realpath', 'basename', 'dirname', 'true', 'false', 'test', '[', 'cd', 'pushd', 'popd'].includes(program)
  }))
  return {
    allowed,
    reason: allowed ? 'conservative read-only compound' : 'contains an unknown or mutating shell segment',
  }
}

function toolFields(data) {
  const rawName = cleanString(data?.tool_name) || cleanString(data?.toolName) || ''
  const lowerName = rawName.toLowerCase()
  const knownVerbs = ['claim_work_item', ...TERMINAL_WORK_VERBS]
  const verb = knownVerbs.find((candidate) =>
    lowerName === candidate ||
    lowerName.endsWith(`_${candidate}`) ||
    lowerName.endsWith(`.${candidate}`),
  ) || ''
  return { rawName, verb, isDevspec: Boolean(verb) }
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

const SUCCESS_STATUSES = {
  claim_work_item: new Set(['success', 'ok', 'claimed', 'in_progress', 'implementing', 'active']),
  record_implementation: new Set(['success', 'ok', 'implemented']),
  release_work_item: new Set(['success', 'ok', 'released', 'idle']),
  fail_work_item: new Set(['success', 'ok', 'failed']),
}

function normalizeStatus(value) {
  return cleanString(value)?.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_') || null
}

function structuredStatuses(result) {
  return [
    result.status,
    result.outcome,
    result.claim_status,
    result.action_item?.status,
    result.action_item?.state,
    result.work_item?.status,
    result.item?.status,
    result.data?.status,
    result.result?.status,
  ]
    .map(normalizeStatus)
    .filter(Boolean)
}

const OUTER_FAILURE_STATUSES = new Set([
  'conflict',
  'error',
  'failure',
  'not_claimed',
  'possible_conflict',
  'unclaimed',
])

function hasOuterFailure(result) {
  const outerStatuses = [result.status, result.outcome, result.claim_status]
    .map(normalizeStatus)
    .filter(Boolean)
  return (
    result.success === false ||
    result.ok === false ||
    result.isError === true ||
    result.is_error === true ||
    result.claim_success === false ||
    result.claimed === false ||
    result.not_claimed === true ||
    result.notClaimed === true ||
    Boolean(result.error) ||
    (Array.isArray(result.errors) && result.errors.length > 0) ||
    Boolean(result.conflict) ||
    Boolean(result.possible_conflict) ||
    Boolean(result.possibleConflict) ||
    outerStatuses.some((status) => OUTER_FAILURE_STATUSES.has(status))
  )
}

function resultItemIds(result) {
  return [
    result.id,
    result.action_item_id,
    result.actionItemId,
    result.work_item_id,
    result.workItemId,
    result.action_item?.id,
    result.action_item?.action_item_id,
    result.work_item?.id,
    result.work_item?.work_item_id,
    result.item?.id,
    result.data?.id,
    result.data?.action_item_id,
    result.data?.actionItemId,
    result.data?.action_item?.id,
    result.result?.id,
    result.result?.action_item_id,
    result.result?.actionItemId,
    result.result?.action_item?.id,
  ].map(cleanString).filter(Boolean)
}

function hasStructuredSuccess(result, verb, args) {
  if (!result || !verb || hasOuterFailure(result)) return false
  if (verb === 'claim_work_item') {
    if (result.claim_success !== true) return false
    const requestedId = claimedItemId(args)
    const returnedIds = resultItemIds(result)
    return returnedIds.length === 0 || Boolean(requestedId && returnedIds.every((id) => id === requestedId))
  }
  const allowed = SUCCESS_STATUSES[verb]
  const statuses = structuredStatuses(result)
  if (statuses.length) return Boolean(allowed && statuses.some((status) => allowed.has(status)))
  if (result.success === true || result.ok === true) return true
  if (verb === 'record_implementation' && result.implemented === true) return true
  if (verb === 'release_work_item' && result.released === true) return true
  if (verb === 'fail_work_item' && result.failed === true) return true
  return false
}

export function parseMcpExecution(data) {
  const { rawName, verb, isDevspec } = toolFields(data)
  const resultPresent = Object.hasOwn(data || {}, 'result_json') || Object.hasOwn(data || {}, 'resultJson')
  const result = parseJsonObject(data?.result_json ?? data?.resultJson)
  const toolInput = parseJsonObject(data?.tool_input ?? data?.toolInput) || {}
  return {
    rawName,
    verb,
    isDevspec,
    successful: Boolean(isDevspec && resultPresent && hasStructuredSuccess(result, verb, toolInput)),
    arguments: toolInput,
  }
}

function claimedItemId(args) {
  return cleanString(args?.action_item_id) || cleanString(args?.actionItemId) || cleanString(args?.id)
}

export function handleHook(mode, data, options = {}) {
  const env = options.env || process.env
  const stateRoot = options.stateRoot || defaultStateRoot(env)
  const scope = options.scope || resolveScope(data, env, options.gitRoot || null)
  const now = options.now || new Date().toISOString()
  const state = scope ? readScopeState(scope, stateRoot) : null

  if (mode === 'afterMCPExecution') {
    const call = parseMcpExecution(data)
    if (!scope || !call.successful) return null
    const actionItemId = claimedItemId(call.arguments)
    if (call.verb === 'claim_work_item' && actionItemId) {
      writeScopeState(scope, {
        armed: true,
        action_item_id: actionItemId,
        armed_at: now,
        last_violation: state?.last_violation || null,
      }, stateRoot)
    } else if (
      TERMINAL_WORK_VERBS.has(call.verb) &&
      state?.armed === true &&
      actionItemId &&
      actionItemId === state.action_item_id
    ) {
      writeScopeState(scope, {
        armed: false,
        action_item_id: null,
        cleared_at: now,
        cleared_by: call.verb,
        last_violation: state?.last_violation || null,
      }, stateRoot)
    }
    return null
  }

  if (mode === 'beforeShellExecution') {
    if (state?.armed === true) return null
    const command = cleanString(data?.command) || cleanString(data?.shell_command) || ''
    if (classifyShellCommand(command).allowed) return null
    return {
      permission: 'deny',
      user_message: CLAIM_WARNING,
      agent_message: CLAIM_WARNING,
    }
  }

  if (mode === 'afterFileEdit') {
    if (state?.armed === true) return null
    const filePath = cleanString(data?.file_path) || cleanString(data?.filePath) || cleanString(data?.path)
    if (scope) {
      writeScopeState(scope, {
        armed: false,
        action_item_id: null,
        last_violation: { event: 'afterFileEdit', file_path: filePath, observed_at: now },
      }, stateRoot)
    }
    return {
      continue: false,
      stopReason: POST_EDIT_WARNING,
      user_message: POST_EDIT_WARNING,
      agent_message: POST_EDIT_WARNING,
      followup_message: POST_EDIT_WARNING,
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
  const mode = String(process.argv[2] || '')
  if (!HOOK_MODES.has(mode)) process.exit(0)
  const output = handleHook(mode, parseHookInput(readStdin()))
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
}

const isMain = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
