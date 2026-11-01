#!/usr/bin/env node
// Every DevSpec tool this plugin tells an agent to call must exist on the server.
//
// The skills, commands, hooks and docs name DevSpec tools, and nothing else checks
// those names against the server: retire or rename a tool there and this plugin
// keeps telling the agent to call it, which fails only at run time, in someone's
// session. This reads the live tool list from a devspecv2 checkout beside this
// repo and fails on any name the server does not have.
//
// With no checkout beside it the test skips, because CI has no pair. Name one
// with DEVSPEC_V2_ROOT; once named, it must be there.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { REQUEST_REF_TOOLS } from './request-ref.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '../..')
const DEFINITIONS = 'apps/web/lib/mcp/tool-definitions.ts'

// Names the scan matches that are not DevSpec tools, each with the reason.
const NOT_DEVSPEC_TOOLS = new Map([])

// The connect path names both of these. A scan that misses them is broken, not clean.
const MUST_FIND = ['register_connection', 'poll_connection']

const NAME = '([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'
// Each pattern says whether what it matches can only be a tool. A qualified name or a
// JSON-RPC call names a tool and nothing else. Prose is looser: "connect them via
// `parent_task_id`" reads exactly like "connect them via `link_tasks`", so a prose match
// may also be one of the server's argument names (item ac7d624b) — but never a name
// the server has neither as a tool nor as an argument, so a retired or misspelt tool
// still fails.
const PATTERNS = [
  // A qualified name: mcp__plugin_devspec_devspec__<tool>, mcp__devspec__<tool>, devspec__<tool>.
  { toolOnly: true, re: new RegExp(`(?<![a-z0-9_])(?:mcp__[a-z0-9_]*?)?devspec(?:_devspec)?__${NAME}`, 'g') },
  // A JSON-RPC tools/call: name: '<tool>', arguments.
  { toolOnly: true, re: new RegExp(`name['"]?\\s*:\\s*['"]${NAME}['"]\\s*,\\s*['"]?arguments`, 'g') },
  // Prose that calls one: `<tool>(`.
  { toolOnly: true, re: new RegExp(`\`${NAME}\\(`, 'g') },
  // Prose that names one to use: call `<tool>`, use `<tool>`, via `<tool>`.
  { toolOnly: false, re: new RegExp(`\\b(?:[Cc]all|[Cc]alling|[Cc]alls|[Uu]se|[Uu]sing|[Vv]ia|[Rr]un|MCP)\\s+\`${NAME}\``, 'g') },
]
// `.mdc` is Cursor's project rule format: rules/devspec.mdc names more tools than any
// other file here and went unchecked until it was added (item ac7d624b).
const SCANNED = /\.(mdc?|mjs|cjs|js|mts|ts|json|toml|ya?ml)$/

/**
 * Every name the patterns find in `text`, and whether any match of it was tool-only.
 * @returns {Map<string, boolean>}
 */
function namesIn(text) {
  const found = new Map()
  for (const { toolOnly, re } of PATTERNS) {
    for (const match of text.matchAll(re)) found.set(match[1], (found.get(match[1]) ?? false) || toolOnly)
  }
  return found
}

/** A tool-only match must be a tool; a prose match may be a tool or an argument. */
function isKnown(name, toolOnly, server) {
  return server.tools.has(name) || (!toolOnly && server.params.has(name))
}

function serverCheckout() {
  const named = process.env.DEVSPEC_V2_ROOT?.trim()
  if (named) return { root: path.resolve(named), named: true }
  // The directories that hold this repo, nearest first. Only ever up, never a walk down.
  for (let dir = path.dirname(ROOT); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'devspecv2')
    if (fs.existsSync(path.join(candidate, DEFINITIONS))) return { root: candidate, named: false }
    if (path.dirname(dir) === dir) return { root: null, named: false }
  }
}

let serverTools = null
function serverToolList(root) {
  if (serverTools) return serverTools
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { getMcpAllTools } from ${JSON.stringify(path.join(root, DEFINITIONS))}
process.stdout.write(JSON.stringify(getMcpAllTools().map((tool) => ({
  name: tool.name,
  params: Object.keys(tool.inputSchema?.properties ?? {}),
  requestRef: Boolean(tool.inputSchema?.properties?.request_ref),
}))))`
  const out = execFileSync(tsx, ['--tsconfig=apps/web/tsconfig.json', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  serverTools = JSON.parse(out)
  return serverTools
}

function serverToolNames(root) {
  return new Set(serverToolList(root).map((tool) => tool.name))
}

/** The server's tools, and every argument name any of them takes. */
function serverVocabulary(root) {
  const list = serverToolList(root)
  return {
    tools: new Set(list.map((tool) => tool.name)),
    params: new Set(list.flatMap((tool) => tool.params)),
  }
}

function referencedNames() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
  const found = new Map()
  for (const file of files) {
    // The changelog names retired tools on purpose: it is history.
    if (!SCANNED.test(file) || path.basename(file) === 'CHANGELOG.md') continue
    if (file.split('/').includes('node_modules')) continue
    const full = path.join(ROOT, file)
    if (full === SELF || !fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    for (const [name, toolOnly] of namesIn(text)) {
      const at = found.get(name) ?? { files: new Set(), toolOnly: false }
      at.files.add(file)
      at.toolOnly ||= toolOnly
      found.set(name, at)
    }
  }
  return found
}

// A call written out in prose, `devspec__<tool>({ a, b: … })` or `devspec__<tool>(a, b)`,
// names that tool's arguments: each must be one the tool takes.
const CALL = /devspec__([a-z][a-z0-9_]*)\(\{([^}]*)\}\)|devspec__([a-z][a-z0-9_]*)\(([a-z_][a-z0-9_, ]*)\)/g

function callArguments(text) {
  const calls = []
  for (const match of text.matchAll(CALL)) {
    const tool = match[1] ?? match[3]
    const keys = (match[2] ?? match[4]).split(',').map((part) => /^\s*([a-z_][a-z0-9_]*)\??\s*(?::|$)/.exec(part)?.[1]).filter(Boolean)
    calls.push({ tool, keys })
  }
  return calls
}

function writtenCalls() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
  const calls = []
  for (const file of files) {
    if (!SCANNED.test(file) || path.basename(file) === 'CHANGELOG.md') continue
    const full = path.join(ROOT, file)
    if (full === SELF || !fs.existsSync(full)) continue
    for (const call of callArguments(fs.readFileSync(full, 'utf8'))) calls.push({ ...call, file })
  }
  return calls
}

// The plugin points at the served implementation contract by name instead of restating
// it ("the contract's `authority_contract.reversal_rule`"). A pointer is only as good as
// its target, so every one must name a section, a key inside one, or a core rule id the
// current contract has.
const CONTRACT = 'packages/core/src/mcp/implementation-contract.ts'
const POINTER = /(?<![a-z0-9_.-])(core\.[a-z][a-z-]*[a-z]|[a-z]+(?:_[a-z]+)*_(?:contract|rule|boundary)(?:\.[a-z_]+)?)\b/g

let servedContract = null
function implementationContract(root) {
  if (servedContract) return servedContract
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { IMPLEMENTATION_CONTRACT } from ${JSON.stringify(path.join(root, CONTRACT))}
process.stdout.write(JSON.stringify(IMPLEMENTATION_CONTRACT))`
  const out = execFileSync(tsx, ['--tsconfig=apps/web/tsconfig.json', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  servedContract = JSON.parse(out)
  return servedContract
}

/** Whether `pointer` names a core rule, a contract section, or a key inside a section. */
function pointerResolves(pointer, contract) {
  if (pointer.startsWith('core.')) {
    return contract.core_implementation_contract.rules.some((rule) => rule.id === pointer)
  }
  const [head, ...rest] = pointer.split('.')
  const sections = Object.values(contract).filter((value) => value && typeof value === 'object' && !Array.isArray(value))
  let node = Object.hasOwn(contract, head) ? contract[head] : sections.find((section) => Object.hasOwn(section, head))?.[head]
  if (node === undefined) return false
  for (const key of rest) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return false
    node = node[key]
  }
  return true
}

function contractPointers() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
  const found = new Map()
  for (const file of files) {
    if (!SCANNED.test(file) || path.basename(file) === 'CHANGELOG.md') continue
    const full = path.join(ROOT, file)
    if (full === SELF || !fs.existsSync(full)) continue
    for (const match of fs.readFileSync(full, 'utf8').matchAll(POINTER)) {
      const at = found.get(match[1]) ?? new Set()
      at.add(file)
      found.set(match[1], at)
    }
  }
  return found
}

function pairedServer(t, read = serverToolNames) {
  const checkout = serverCheckout()
  if (checkout.root && fs.existsSync(path.join(checkout.root, DEFINITIONS))) return read(checkout.root)
  if (checkout.named) assert.fail(`DEVSPEC_V2_ROOT names ${checkout.root}, which has no ${DEFINITIONS}`)
  t.skip('no devspecv2 checkout beside this repo')
  return null
}

describe('DevSpec tools this plugin names', () => {
  it('are all tools the server has', (t) => {
    const server = pairedServer(t, serverVocabulary)
    if (!server) return
    const found = referencedNames()
    for (const name of MUST_FIND) assert.ok(found.has(name), `the scan did not find ${name}: it is broken, not clean`)
    const unknown = [...found]
      .filter(([name, at]) => !isKnown(name, at.toolOnly, server) && !NOT_DEVSPEC_TOOLS.has(name))
      .map(([name, at]) => `${name} (${[...at.files].sort().join(', ')})`)
    assert.deepEqual(unknown, [], `named here, but the server has no such tool:\n  ${unknown.join('\n  ')}`)
  })

  it('accept an argument named in prose, and still refuse a retired, misspelt or misused name', (t) => {
    const server = pairedServer(t, serverVocabulary)
    if (!server) return
    const unknownIn = (text) =>
      [...namesIn(text)].filter(([name, toolOnly]) => !isKnown(name, toolOnly, server)).map(([name]) => name)
    // Arguments the server takes, named the way the skills and rules name them.
    assert.deepEqual(unknownIn('connect them via `parent_task_id`, or use `companion_links`.'), [])
    // A tool the server retired, and a misspelling of a live one, in every shape.
    assert.deepEqual(unknownIn('call `update_action_item` to change it'), ['update_action_item'])
    assert.deepEqual(unknownIn('then `devspec__claim_work_items(` it'), ['claim_work_items'])
    assert.deepEqual(unknownIn('`get_next_work_item(task_id)`'), ['get_next_work_item'])
    // An argument is never a tool: a qualified call or a JSON-RPC call to one still fails.
    assert.deepEqual(unknownIn('`devspec__parent_task_id`'), ['parent_task_id'])
    assert.deepEqual(unknownIn(`{ name: 'companion_links', arguments: {} }`), ['companion_links'])
  })

  it('are called with arguments those tools take', (t) => {
    const tools = pairedServer(t, serverToolList)
    if (!tools) return
    const params = new Map(tools.map((tool) => [tool.name, new Set(tool.params)]))
    const calls = writtenCalls()
    assert.ok(calls.some((call) => call.tool === 'post_session_message'), 'the call scan found nothing: it is broken, not clean')
    const wrong = calls.flatMap(({ tool, keys, file }) =>
      params.has(tool) ? keys.filter((key) => !params.get(tool).has(key)).map((key) => `${tool}(${key}) in ${file}`) : [])
    assert.deepEqual(wrong, [], `written with an argument the tool does not take:\n  ${wrong.join('\n  ')}`)
    // The parse reads both shapes, so a wrong argument cannot hide in either.
    assert.deepEqual(callArguments('`devspec__claim_work_item(task_id, branch)`'), [{ tool: 'claim_work_item', keys: ['task_id', 'branch'] }])
    assert.deepEqual(callArguments('devspec__create_session({ access: "private", title?, initial_message? })'),
      [{ tool: 'create_session', keys: ['access', 'title', 'initial_message'] }])
  })

  it('set aside only names that are still used and are still not DevSpec tools', (t) => {
    const server = pairedServer(t)
    if (!server) return
    const found = referencedNames()
    for (const name of NOT_DEVSPEC_TOOLS.keys()) {
      assert.ok(found.has(name), `${name} is set aside but nothing here names it any more; remove it`)
      assert.ok(!server.has(name), `${name} is set aside but it is a DevSpec tool now; remove it so it is checked`)
    }
  })
})

describe('the served-contract pointers this plugin gives', () => {
  it('name sections, keys and rules the current implementation contract has', (t) => {
    const contract = pairedServer(t, implementationContract)
    if (!contract) return
    const tools = pairedServer(t)
    const found = contractPointers()
    for (const name of ['work_entry_contract', 'authority_contract.reversal_rule', 'core.waiting-work-stays-on-its-branch']) {
      assert.ok(found.has(name), `the scan did not find ${name}: it is broken, not clean`)
    }
    const dangling = [...found]
      .filter(([pointer]) => !tools.has(pointer) && !pointerResolves(pointer, contract))
      .map(([pointer, files]) => `${pointer} (${[...files].sort().join(', ')})`)
    assert.deepEqual(dangling, [], `pointed at, but contract ${contract.contract_version} has no such part:\n  ${dangling.join('\n  ')}`)
    // A misspelt pointer is caught, not waved through as a loose match.
    for (const wrong of ['authority_contract.reversal_rules', 'core.waiting-work-stays-on-branch', 'work_intake_contract']) {
      assert.equal(pointerResolves(wrong, contract), false, wrong)
    }
  })
})

describe('the DevSpec writes that record who asked', () => {
  // request-ref.mjs refuses one of these while a turn carries two people's requests
  // (item 56ba1b79), so the list must be the server's: a write missing from it
  // would be credited by guess, and a read on it refused for nothing.
  it('are exactly the tools that take request_ref', (t) => {
    const tools = pairedServer(t, serverToolList)
    if (!tools) return
    const server = tools.filter((tool) => tool.requestRef).map((tool) => tool.name).sort()
    if (server.length === 0) return t.skip('this server predates request_ref (item 7a4d04fd)')
    assert.deepEqual([...REQUEST_REF_TOOLS].sort(), server)
  })
})
