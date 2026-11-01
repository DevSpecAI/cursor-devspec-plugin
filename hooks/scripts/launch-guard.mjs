#!/usr/bin/env node
/**
 * PreToolUse for a call that would start work outliving it — a background command
 * or subagent, a workflow, a monitor, a scheduled wake-up, a cron (item 56ba1b79).
 *
 * Whatever that work does when it later wakes the agent is credited to the request
 * it was started for. While the turn carries requests that would be recorded
 * differently and the agent has not said which it is working on, nothing here can
 * know which one this work is for, so the launch is refused with the one command
 * that names it. Never a guess, and nothing is started under one.
 */

import os from 'node:os'
import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ownConnectionId } from './own-connection.mjs'
import { firingConversation } from './project-context.mjs'
import {
  readRequestState,
  selectableRequests,
  servableCarried,
  startsBackgroundWork,
  turnAmbiguity,
  undecidedTurnMessage,
} from './requests.mjs'

export function launchGuard(input, { home = os.homedir(), env = process.env } = {}) {
  const toolName = input?.tool_name ?? input?.toolName
  const toolInput = input?.tool_input ?? input?.toolInput ?? input
  if (!startsBackgroundWork(toolName, toolInput)) return {}
  const conversationId = firingConversation(input) || (typeof input?.session_id === 'string' ? input.session_id : null)
  const connectionId = ownConnectionId(conversationId, { home, env })
  if (!connectionId) return {}
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  const agentId = typeof input?.agent_id === 'string' && input.agent_id ? input.agent_id : null
  const state = readRequestState(connectionId, { dir })
  const carried = turnAmbiguity(state, agentId)
  if (!carried) return {}
  const reason = undecidedTurnMessage(
    connectionId,
    servableCarried(state, selectableRequests(state) ?? carried),
    'whatever this background work does when it wakes you',
  )
  return {
    permission: 'deny',
    user_message: reason,
    agent_message: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

let main = false
try {
  main = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {
  /* imported */
}
if (main) {
  try {
    const out = launchGuard(JSON.parse(readFileSync(0, 'utf8')))
    if (out && Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out))
  } catch {
    /* fail open on unreadable stdin */
  }
}
