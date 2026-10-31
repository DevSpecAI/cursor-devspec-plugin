#!/usr/bin/env node
/** Cursor native input update + server-aware send guard (e1b5eda7, 56ba1b79).
 * PreToolUse has no provider identity, so only reserved transport names are patched.
 * BeforeMCPExecution proves the server before any of those arguments leave the host.
 *
 * A post_session_message that replies to DevSpec notices goes out as a notice reply
 * (notice-reply.mjs): the model's `system_notice_ids` as an array, or, in a turn every
 * wake of which was a notice, those notices' ids on a plain post; always with the
 * connection, and never with the local-turn flags a typed turn's answer carries.
 */
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { connectionVersionHook } from './connection-version.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { storeRepositorySnapshot, refreshRepositoryRules } from './repository-context.mjs'
import {
  UUID,
  firingConversation,
  namespacedVerb,
  isDevspecServer as isServer,
  PROJECTLESS,
  readProjectContext,
  selectProjectContext,
  candidate,
  toolArguments,
} from './project-context.mjs'
import { readOwnConnectionState, withOwnConnection } from './own-connection.mjs'
import { prePostHoldReason } from './room-unread.mjs'
import { stampRequest } from './request-ref.mjs'
import { readRequestState } from './requests.mjs'
import { currentTurnNoticeIds, normalizeNoticeIds, prepareNoticeReply, recordNoticeReply } from './notice-reply.mjs'

const CAPABILITY_BRIDGE_HELPERS = {
  manage_plan: 'manage-plan',
  manage_poll: 'manage-poll',
  manage_directed_question: 'manage-question',
}
const deny = (message) => ({ permission: 'deny', user_message: message, agent_message: message })

export function projectInput(mode, input, { home, env = process.env } = {}) {
  const name = input?.tool_name ?? input?.toolName
  const namespaced = namespacedVerb(name)
  if (mode === 'pre') {
    if (!namespaced) return connectionVersionHook(input)
    if (CAPABILITY_BRIDGE_HELPERS[namespaced]) {
      const helper = CAPABILITY_BRIDGE_HELPERS[namespaced]
      return deny(
        `${namespaced} requires the per-connection capability header. Use \`remote-control-state.mjs ${helper} describe\` and \`remote-control-state.mjs ${helper} use\` instead of calling it over global MCP.`,
      )
    }
    const versions = connectionVersionHook({ ...input, tool_name: namespaced })?.updated_input ?? {}
    if (PROJECTLESS.has(namespaced)) return Object.keys(versions).length ? { updated_input: versions } : null
    const id = firingConversation(input)
    if (!id) return deny('Cursor did not provide this conversation’s identity. Restart the agent before using DevSpec.')
    try {
      const args = toolArguments(input)
      const identity = namespaced === 'register_connection' ? { local_id: id, agent_name: AGENT_NAME } : {}
      if (namespaced === 'register_connection' && args.local_id && args.local_id !== id) {
        return deny('Register only this Cursor conversation; do not reuse another conversation’s ID.')
      }
      const selected = readProjectContext(id, null, home)
      let projectPatch = {}
      if (selected?.status === 'blocked') {
        if (!(namespaced === 'register_connection' && args.project_id)) {
          return deny(selected.message || 'Choose a project with /devspec-remote --project <id>.')
        }
      } else if (selected) {
        if (args.project_id && args.project_id !== selected.project.id) {
          return deny(
            'This conversation uses a different project. Start a fresh Cursor chat to switch; the current connection is unchanged.',
          )
        }
        projectPatch = { project_id: selected.project.id }
      }

      if (
        namespaced === 'post_session_message' &&
        args.phase !== 'trail' &&
        args.phase !== 'needs_input'
      ) {
        const holdReason = prePostHoldReason({
          input,
          env,
          ...(home ? { home } : {}),
        })
        if (holdReason) return deny(holdReason)
      }

      const connState = readOwnConnectionState(id, { ...(home ? { home } : {}), env })
      const connectionId = connState?.connection_id ?? null
      const hasModelRequestRef = Object.hasOwn(args, 'request_ref')
      const hasPostProvenanceRef =
        namespaced === 'post_session_message' && Object.hasOwn(args, 'provenance_ref')

      if (!connectionId && !hasModelRequestRef && !hasPostProvenanceRef) {
        // No connection here, but ids a stale tool list sent as text still go out as
        // the list DevSpec takes, so its refusal (no room) is about the room, not the shape.
        const ids = namespaced === 'post_session_message' && typeof args.system_notice_ids === 'string'
          ? normalizeNoticeIds(args.system_notice_ids)
          : undefined
        const patch = { ...versions, ...identity, ...projectPatch, ...(Array.isArray(ids) ? { system_notice_ids: ids } : {}) }
        return Object.keys(patch).length ? { updated_input: patch } : null
      }

      let next = { ...args, ...versions, ...identity, ...projectPatch }
      if (hasPostProvenanceRef) {
        delete next.provenance_ref
      }
      const connDir = path.join(home || os.homedir(), '.devspec', 'remote-control', 'connections')
      let noticeReply = false
      if (namespaced === 'post_session_message') {
        const turnNotices = connectionId && args.system_notice_ids === undefined
          ? currentTurnNoticeIds(connectionId, { dir: connDir, connectionState: connState })
          : null
        const prepared = prepareNoticeReply(next, { connectionId, turnNotices })
        if (prepared) {
          next = prepared
          noticeReply = true
        }
      }
      next = withOwnConnection(namespaced, next, connectionId)
      const stamped = stampRequest(namespaced, next, connectionId, input?.agent_id, {
        ...(home ? { home } : {}),
        connectionState: connState,
        includeProvenance: true,
      })
      if (stamped.deny) return deny(stamped.deny)
      next = stamped.args

      // A notice reply is outside every turn: it takes no local-turn flags, and a
      // later Stop must not post the turn's final words as a second reply.
      if (noticeReply && connectionId) recordNoticeReply(connectionId, { dir: connDir })

      if (
        namespaced === 'post_session_message' &&
        !noticeReply &&
        next.phase !== 'trail' &&
        next.phase !== 'needs_input' &&
        next.turn_kind !== 'local_prompt' &&
        !next.command_turn_id &&
        next.command_turn_unbound === undefined &&
        !next.interaction_event_id &&
        !next.question_dismissal_event_id
      ) {
        const targetConnId = next.connection_id || connectionId
        if (targetConnId) {
          const reqState = readRequestState(targetConnId, { dir: connDir })
          const currentReq = reqState?.current ? reqState.open.get(reqState.current) : null
          const isLocalTurn = Boolean(connState?.local_turn || currentReq?.kind === 'typed_prompt')
          if (isLocalTurn) {
            next = {
              ...next,
              local_turn: true,
              command_turn_unbound: true,
            }
          }
        }
      }

      return Object.keys(next).length || hasModelRequestRef || hasPostProvenanceRef
        ? { updated_input: next }
        : null
    } catch (error) {
      return deny(error.message)
    }
  }
  if (mode === 'after') {
    if (!isServer(input?.mcp_server_name) || !['register_connection', 'attach_connection'].includes(namespaced)) return null
    try {
      const id = firingConversation(input)
      const args = toolArguments(input)
      const result = typeof input.result_json === 'string' ? JSON.parse(input.result_json) : input.result_json
      if (!id || (namespaced === 'register_connection' && args.local_id !== id) || result?.isError || !Array.isArray(result?.content)) return null
      const data = JSON.parse(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
      if (namespaced === 'attach_connection') {
        if (data.connection_id === args.connection_id && UUID.test(data.connection_id ?? '')) refreshRepositoryRules(id, data, home)
        return null
      }
      const project = candidate(data.project_selection?.project) ?? candidate({ id: data.project_id, name: data.project_id })
      if (!project || data.project_id !== project.id || !UUID.test(data.connection_id ?? '')) return null
      selectProjectContext(id, input.mcp_server_url || input.url, project, data.project_selection?.source ?? 'conversation', home)
      storeRepositorySnapshot(id, data, home)
    } catch {
      /* no invented or partial selection from an unproven receipt */
    }
    return null
  }
  if (mode !== 'before') return null
  if (namespaced && !isServer(input?.mcp_server_name)) {
    return deny('A DevSpec-namespaced tool was routed to another MCP server. Check the MCP configuration; no request was sent.')
  }
  if (!isServer(input?.mcp_server_name)) return null
  const verb = namespaced ?? String(name ?? '')
  if (CAPABILITY_BRIDGE_HELPERS[verb]) {
    const helper = CAPABILITY_BRIDGE_HELPERS[verb]
    return deny(
      `${verb} requires the per-connection capability header. Use \`remote-control-state.mjs ${helper} describe\` and \`remote-control-state.mjs ${helper} use\` instead of calling it over global MCP.`,
    )
  }
  if (PROJECTLESS.has(verb)) return null
  const id = firingConversation(input)
  if (!id) return deny('Cursor did not provide this conversation’s identity. Restart the agent before using DevSpec.')
  try {
    const args = toolArguments(input)
    const connState = readOwnConnectionState(id, { ...(home ? { home } : {}), env })
    const connectionId = connState?.connection_id ?? null
    if (connectionId || Object.hasOwn(args, 'request_ref')) {
      const stamped = stampRequest(verb, args, connectionId, input?.agent_id, {
        ...(home ? { home } : {}),
        connectionState: connState,
        includeProvenance: true,
      })
      if (stamped.deny) return deny(stamped.deny)
      if (args.request_ref !== undefined && args.request_ref !== stamped.args.request_ref) {
        return deny('request_ref is stamped by the host and may not be supplied by the model.')
      }
    }
    const endpoint = input.mcp_server_url || input.url
    const selected = readProjectContext(id, endpoint || null, home)
    if (!selected) return null
    if (!endpoint) return deny('The DevSpec server address could not be verified. Use the plugin’s HTTP MCP setup.')
    if (selected.status === 'blocked') {
      return verb === 'register_connection' && args.local_id === id && args.project_id
        ? null
        : deny(selected.message || 'Choose a project first.')
    }
    if (args.project_id !== selected.project.id) {
      return deny(
        `This conversation uses project ${selected.project.id}. Update the DevSpec MCP setup and restart Cursor to load its namespaced tools, or pass that exact project_id on this call. Never choose a different project implicitly.`,
      )
    }
    return null // normal host permissions still apply; never emit an allow override
  } catch (error) {
    return deny(error.message)
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = projectInput(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8')))
    if (output) process.stdout.write(JSON.stringify(output))
  } catch {
    process.stdout.write(
      JSON.stringify(deny('DevSpec could not safely read the current conversation scope. Reconnect before using its project tools.')),
    )
  }
}
