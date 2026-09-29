#!/usr/bin/env node
/** Cursor native input update + server-aware send guard (e1b5eda7).
 * PreToolUse has no provider identity, so only reserved transport names are patched.
 * BeforeMCPExecution proves the server before any of those arguments leave the host.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { connectionVersionHook } from './connection-version.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { UUID, firingConversation, namespacedVerb, isDevspecServer as isServer, PROJECTLESS, readProjectContext, selectProjectContext, candidate, toolArguments } from './project-context.mjs'
const deny = message => ({ permission: 'deny', user_message: message, agent_message: message })
export function projectInput(mode, input, { home } = {}) {
  const name = input?.tool_name ?? input?.toolName
  const namespaced = namespacedVerb(name)
  if (mode === 'pre') {
    if (!namespaced) return connectionVersionHook(input)
    const versions = connectionVersionHook({ ...input, tool_name: namespaced })?.updated_input ?? {}
    if (PROJECTLESS.has(namespaced)) return Object.keys(versions).length ? { updated_input: versions } : null
    const id = firingConversation(input)
    if (!id) return deny('Cursor did not provide this conversation’s identity. Restart the agent before using DevSpec.')
    try {
      const args = toolArguments(input)
      const identity = namespaced === 'register_connection' ? { local_id: id, agent_name: AGENT_NAME } : {}
      if (namespaced === 'register_connection' && args.local_id && args.local_id !== id) return deny('Register only this Cursor conversation; do not reuse another conversation’s ID.')
      const selected = readProjectContext(id, null, home)
      if (!selected) return Object.keys({ ...versions, ...identity }).length ? { updated_input: { ...versions, ...identity } } : null
      if (selected.status === 'blocked') return namespaced === 'register_connection' && args.project_id
        ? { updated_input: { ...versions, ...identity } }
        : deny(selected.message || 'Choose a project with /devspec.remote --project <id>.')
      if (args.project_id && args.project_id !== selected.project.id) return deny('This conversation uses a different project. Start a fresh Cursor chat to switch; the current connection is unchanged.')
      return { updated_input: { ...versions, ...identity, project_id: selected.project.id } }
    } catch (error) { return deny(error.message) }
  }
  if (mode === 'after') {
    if (!isServer(input?.mcp_server_name) || namespaced !== 'register_connection') return null
    try {
      const id = firingConversation(input), args = toolArguments(input)
      const result = typeof input.result_json === 'string' ? JSON.parse(input.result_json) : input.result_json
      if (!id || args.local_id !== id || result?.isError || !Array.isArray(result?.content)) return null
      const data = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      const project = candidate(data.project_selection?.project) ?? candidate({ id: data.project_id, name: data.project_id })
      if (!project || data.project_id !== project.id || !UUID.test(data.connection_id ?? '')) return null
      selectProjectContext(id, input.mcp_server_url || input.url, project, data.project_selection?.source ?? 'conversation', home)
    } catch { /* no invented or partial selection from an unproven receipt */ }
    return null
  }
  if (mode !== 'before') return null
  if (namespaced && !isServer(input?.mcp_server_name)) return deny('A DevSpec-namespaced tool was routed to another MCP server. Check the MCP configuration; no request was sent.')
  if (!isServer(input?.mcp_server_name)) return null
  const verb = namespaced ?? String(name ?? '')
  if (PROJECTLESS.has(verb)) return null
  const id = firingConversation(input)
  if (!id) return deny('Cursor did not provide this conversation’s identity. Restart the agent before using DevSpec.')
  try {
    const endpoint = input.mcp_server_url || input.url
    const selected = readProjectContext(id, endpoint || null, home)
    if (!selected) return null
    if (!endpoint) return deny('The DevSpec server address could not be verified. Use the plugin’s HTTP MCP setup.')
    const args = toolArguments(input)
    if (selected.status === 'blocked') return verb === 'register_connection' && args.local_id === id && args.project_id
      ? null : deny(selected.message || 'Choose a project first.')
    if (args.project_id !== selected.project.id) return deny(`This conversation uses project ${selected.project.id}. Update the DevSpec MCP setup and restart Cursor to load its namespaced tools, or pass that exact project_id on this call. Never choose a different project implicitly.`)
    return null // normal host permissions still apply; never emit an allow override
  } catch (error) { return deny(error.message) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const output = projectInput(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8'))); if (output) process.stdout.write(JSON.stringify(output)) }
  catch { process.stdout.write(JSON.stringify(deny('DevSpec could not safely read the current conversation scope. Reconnect before using its project tools.'))) }
}
