/** Cursor-owned conversation scope. Folder pins remain shared defaults, not this state. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
export function endpointIdentity(value) {
  const url = new URL(value)
  if (url.username || url.password) throw new Error('DevSpec credentials belong in headers, not the server URL.')
  url.searchParams.delete('tool_namespace'); url.hash = ''
  return url.toString()
}
export function candidate(value) {
  const row = record(value)
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.name !== 'string') return null
  const org = record(row.organization)
  return { id: row.id, name: row.name, organization: org && typeof org.id === 'string' && UUID.test(org.id) && typeof org.name === 'string' ? { id: org.id, name: org.name } : null }
}
export function choiceFromFailure(error) {
  const body = error?.details
  const choice = record(body?.project_selection)
  if (body?.code !== 'project_choice_required' || choice?.version !== 1 || choice.status !== 'choice_required' || !Array.isArray(choice.candidates)) return null
  const rows = choice.candidates.map(candidate)
  if (rows.some(row => !row || !row.organization)) return null
  return { version: 1, status: 'choice_required', reason: String(choice.reason), candidates: rows }
}
export function contextFile(conversationId, home = os.homedir()) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('Cursor must supply its own conversation ID; a folder is not a conversation.')
  const key = createHash('sha256').update(conversationId).digest('hex')
  return path.join(home, '.devspec', 'cursor-project-context', `${key}.json`)
}
export function readProjectContext(conversationId, endpoint = null, home = os.homedir()) {
  if (!conversationId) return null
  let text
  try { text = fs.readFileSync(contextFile(conversationId, home), 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read this conversation’s project. Reconnect before using DevSpec.')
    try { text = fs.readFileSync(`${contextFile(conversationId, home)}.blocked`, 'utf8') }
    catch (blockedError) { if (blockedError.code === 'ENOENT') return null; throw new Error('Cannot read the pending project choice.') }
  }
  let data
  try { data = JSON.parse(text) } catch { throw new Error('The saved conversation project is unreadable. Start a fresh Cursor conversation; do not fall back to a folder default.') }
  if (data?.version !== 1 || data.conversation_id !== conversationId || !['selected', 'blocked'].includes(data.status) || typeof data.endpoint !== 'string') throw new Error('Invalid saved conversation project.')
  if (endpoint && endpointIdentity(endpoint) !== data.endpoint) throw new Error('This conversation was connected to another DevSpec server. Start a fresh conversation.')
  if (data.status === 'selected' && !candidate(data.project)) throw new Error('Invalid saved project identity.')
  return data
}
function storeContext(id, data, home) {
  const file = `${contextFile(id, home)}.blocked`, temp = `${file}.${randomUUID()}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try { fs.writeFileSync(temp, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file) }
  finally { try { fs.unlinkSync(temp) } catch {} }
  return data
}
export function selectProjectContext(id, endpoint, project, source = 'conversation', home = os.homedir()) {
  const chosen = candidate(project)
  if (!chosen) throw new Error('DevSpec did not confirm a valid project.')
  const previous = readProjectContext(id, endpoint, home)
  if (previous?.status === 'selected') {
    if (previous.project.id !== chosen.id) throw new Error('This conversation already belongs to another project. Create a fresh Cursor chat to switch.')
    return previous
  }
  const data = { version: 1, conversation_id: id, endpoint: endpointIdentity(endpoint), status: 'selected', project: chosen, source }
  const file = contextFile(id, home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    // Exclusive first creation: concurrent first choices cannot replace each
    // other. A partial/crashed write fails closed on read, never changes scope.
    fs.writeFileSync(file, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' })
    return data
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const winner = readProjectContext(id, endpoint, home)
    if (winner?.status === 'selected' && winner.project.id === chosen.id) return winner
    throw new Error('Another project choice already owns this conversation. Create a fresh Cursor chat to switch.')
  }
}
export function blockProjectContext(id, endpoint, message, home = os.homedir(), requiresExplicit = false) {
  if (readProjectContext(id, endpoint, home)?.status === 'selected') return
  storeContext(id, { version: 1, conversation_id: id, endpoint: endpointIdentity(endpoint), status: 'blocked', message, requires_explicit: requiresExplicit }, home)
}
export function selectNamedProject(projects, value) {
  const key = value.trim().toLowerCase()
  return projects.filter(project => project.id.toLowerCase() === key || project.name.toLowerCase() === key)
}
export function firingConversation(input) {
  return input?.conversation_id || input?.conversationId || input?.session_id || null
}
export function namespacedVerb(name) {
  const value = String(name ?? '').replace(/^MCP:/, '')
  return /^devspec__[a-z][a-z0-9_]*$/.test(value) ? value.slice('devspec__'.length) : null
}
export function isDevspecServer(value) { return ['devspec', 'plugin:devspec-autopilot:devspec', 'devspec-autopilot:devspec'].includes(String(value ?? '').toLowerCase()) }
export const PROJECTLESS = new Set(['list_projects', 'verify_agent_connection', 'devspec_help_search', 'get_personal_instructions', 'update_personal_instructions'])
export function toolArguments(input) {
  const value = input?.tool_input ?? input?.toolInput ?? {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!record(parsed)) throw new Error('DevSpec tool arguments must be a JSON object.')
  return parsed
}
