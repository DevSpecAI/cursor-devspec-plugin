#!/usr/bin/env node
/** Cursor's project skill uses this mechanical helper; it never opens a terminal picker. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { spawnAgentSync } from '../../scripts/launch-cli-session.mjs'
import { detectLocalId } from './remote-control-state.mjs'
import { findProjectPin } from './provenance-assistance.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { candidate, readProjectContext, selectNamedProject } from './project-context.mjs'

function pinRoot(cwd) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 3000 }).trim() }
  catch { return path.resolve(cwd) }
}
const fingerprint = file => {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error }
}
export function folderDefault(action, { cwd, selection, confirm = false, expected, home = os.homedir() }) {
  const effective = findProjectPin(cwd, { home })
  if (action === 'status') return { ok: true, selection, folder_default: effective }
  if (action !== 'remember' && action !== 'forget') throw new Error('Use status, list, remember, forget or prepare.')
  if (action === 'remember' && selection?.status !== 'selected') throw new Error('Connect this conversation to a project before remembering its default.')
  if (action === 'forget' && !effective) return { ok: true, changed: false, message: 'No folder default to forget.' }
  const root = pinRoot(cwd), target = action === 'forget' ? effective.path : path.join(root, '.devspec', 'project.json')
  if (action === 'remember' && effective && effective.path !== target) {
    const inside = path.relative(root, path.dirname(path.dirname(effective.path)))
    if (inside && inside !== '..' && !inside.startsWith(`..${path.sep}`)) throw new Error(`A nearer pin at ${effective.path} would override this default. Manage it explicitly.`)
  }
  const current = fingerprint(target)
  const preview = { action, path: target, expected: current, current_default: effective, project: selection?.project ?? null,
    message: 'This file may be shared or committed. Only future folder-based connections use the change; existing conversations keep their project. A unique remote still beats a pin.' }
  if (!confirm || expected !== current) return { ok: false, confirmation_required: true, ...preview }
  if (action === 'forget') fs.unlinkSync(target)
  else {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try { fs.writeFileSync(temporary, JSON.stringify({ project_id: selection.project.id }, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); fs.renameSync(temporary, target) }
    finally { try { fs.unlinkSync(temporary) } catch {} }
  }
  return { ok: true, changed: true, path: target, selection, folder_default: findProjectPin(cwd, { home }) }
}
export function findNativeCursorCli({ cwd, cursorBin, spawn = spawnAgentSync } = {}) {
  // Never silently invoke another host's generic `agent` command.
  const bins = cursorBin ? [cursorBin] : ['cursor-agent', 'agent']
  for (const bin of bins) {
    const help = spawn(bin, ['--help'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 10000 })
    if (help.status !== 0 || !String(help.stdout).includes('Start the Cursor Agent')) continue
    return bin
  }
  throw new Error('Could not find the Cursor CLI. Pass --cursor-bin with its actual executable; do not use another agent’s executable.')
}
export async function prepareCursorProject(selector, { cwd = process.cwd(), cursorBin, auth = resolveDevspecMcpAuth(cwd), call = mcpToolsCall, findCli = findNativeCursorCli } = {}) {
  if (!selector || !auth.ok) throw new Error('Provide --project <name-or-id> and valid DevSpec authentication.')
  const listing = await call({ mcpUrl: auth.mcp_url, token: auth.token, name: 'list_projects', arguments: {}, timeoutMs: 30000 })
  const projects = Array.isArray(listing.projects) ? listing.projects.map(candidate) : null
  if (!projects || projects.some(project => !project)) throw new Error('DevSpec did not return valid project choices.')
  const matches = selectNamedProject(projects, selector)
  if (matches.length !== 1) return { ok: false, code: 'project_choice_required', project_selection: { version: 1, status: 'choice_required', reason: matches.length ? 'ambiguous_name' : 'unknown_name', candidates: matches.length ? matches : projects } }
  const executable = findCli({ cwd, cursorBin })
  // Bare Cursor starts a fresh chat. Do not mint a look-alike ID, reuse a
  // previous --resume, or kill create-chat while its store is still disposing.
  return { ok: true, project: matches[0], launch_argv: [executable], requires_fresh_chat: true,
    first_message: `/devspec.remote --project ${matches[0].id}`,
    message: 'Start this Cursor command in a new terminal, without --resume or --continue, then send first_message there. This is a handoff, not a launched chat: your current conversation and folder default are unchanged.' }
}
async function main() {
  const argv = process.argv.slice(2), action = argv.shift() || 'status'
  const opts = { cwd: process.cwd(), confirm: false }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--confirm') opts.confirm = true
    else if (['--cwd','--local-id','--expected','--project','--cursor-bin'].includes(key)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
      opts[key.slice(2)] = value
    } else throw new Error(`Unknown option: ${key}`)
  }
  if (action === 'prepare') { console.log(JSON.stringify(await prepareCursorProject(opts.project, { cwd: opts.cwd, cursorBin: opts['cursor-bin'] }))); return }
  const auth = resolveDevspecMcpAuth(opts.cwd)
  if (action === 'list') {
    if (!auth.ok) throw new Error('Connect your DevSpec account first.')
    console.log(JSON.stringify(await mcpToolsCall({ mcpUrl: auth.mcp_url, token: auth.token, name: 'list_projects', arguments: {}, timeoutMs: 30000 }))); return
  }
  const id = detectLocalId({ 'local-id': opts['local-id'] }).local_id
  const selection = readProjectContext(id, auth.mcp_url || null)
  console.log(JSON.stringify(folderDefault(action, { ...opts, selection })))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
