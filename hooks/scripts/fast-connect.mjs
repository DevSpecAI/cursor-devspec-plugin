/**
 * Mechanical Cursor Connect (item 1cc2a2d5) — register / optional attach / write
 * state BEFORE the agent resumes. The poller is started after `agent --resume`
 * has a durable owner PID (item f099fc6e). The model only arms wait and handles
 * owner commands (thin post-Live brief).
 *
 * Usage (CLI via remote-control-state.mjs):
 *   node remote-control-state.mjs fast-connect --local-id <id> [--session <uuid>]
 *       [--cwd <path>] [--launch-id <uuid>] [--project-id <uuid>] [--prompt-file <path>]
 *
 * Or import { fastConnect } from './fast-connect.mjs' (launch-cli-session).
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mcpToolsCall, mcpToolsCallWithRetry } from './mcp-call.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { UUID, candidate, selectNamedProject, readProjectContext, selectProjectContext, blockProjectContext } from './project-context.mjs'
import { readRepositorySnapshot, storeRepositorySnapshot, repositoryContextTextFile } from './repository-context.mjs'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import {
  durationMs,
  emitConnectPhase,
  resolveLaunchId,
} from './connect-phase-timing.mjs'
import {
  detectLocalId,
  resolveLocalAction,
  registerConnection,
  attachConnection,
  writeConnectionState,
} from './remote-control-state.mjs'

/** UUID values for these keys are never session ids (automation cold-launch, etc.). */
const NON_SESSION_UUID_KEY =
  /(?:project_id|automation_id|run_id|connection_id|local_id|launch_id|automation_run_id|action_item_id|item_id)\s*=\s*$/i

/**
 * Pull `--session <uuid>` / `--session=<uuid>` from a Connect prompt.
 * @param {string | null | undefined} promptBody
 * @returns {string | null}
 */
export function parseSessionIdFromPrompt(promptBody) {
  if (typeof promptBody !== 'string' || !promptBody.trim()) return null

  // Automation cold launch is sessionless — register only, then claim_automation_run.
  if (/devspec automation run waiting/i.test(promptBody)) return null

  const flagged = promptBody.match(
    /--session(?:\s+|=)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})\b/i,
  )
  if (flagged?.[1]) return flagged[1]

  const explicit = promptBody.match(
    /session_id(?:\s*[:=]\s*)["']?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})\b/i,
  )
  if (explicit?.[1]) return explicit[1]

  // A project selector is not a room. Combined usage must name --session explicitly.
  if (/--project(?:-id|_id)?(?:\s|=)/i.test(promptBody)) return null

  // Bare uuid only when the prompt is clearly remote connect — skip project/automation/run ids.
  const lower = promptBody.toLowerCase()
  if (
    lower.includes('devspec.remote') ||
    lower.includes('register_connection') ||
    lower.includes('attach_connection')
  ) {
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
    let match
    while ((match = re.exec(promptBody)) !== null) {
      const prefix = promptBody.slice(Math.max(0, match.index - 32), match.index)
      if (NON_SESSION_UUID_KEY.test(prefix)) continue
      return match[0]
    }
  }
  return null
}

/**
 * @param {string} cwd
 * @param {{ execFileSyncImpl?: typeof execFileSync }} [opts]
 * @returns {string | null}
 */
export function resolveGitRemote(cwd, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const out = execFileSyncImpl('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    })
    const url = String(out || '').trim()
    return url || null
  } catch {
    return null
  }
}

/**
 * Resolve only an explicit project name/ID. Automatic remote/pin ranking belongs
 * to the server at registration, so an ordinary connect makes no discovery call.
 * @param {{
 *   cwd: string,
 *   gitRemote?: string | null,
 *   projectId?: string | null,
 *   auth: { ok: boolean, token?: string, mcp_url?: string, error?: string },
 *   launchId?: string | null,
 *   agent?: string,
 *   mcpCall?: typeof mcpToolsCall,
 *   emitPhase?: typeof emitConnectPhase,
 * }} opts
 */
export async function resolveProjectForConnect(opts) {
  const {
    cwd,
    gitRemote = null,
    projectId = null,
    auth,
    launchId = null,
    agent = AGENT_NAME,
    mcpCall = mcpToolsCallWithRetry,
    emitPhase = emitConnectPhase,
  } = opts
  const started = Date.now()

  if (!projectId) return { ok: true, project_id: null, git_remote: gitRemote, source: 'server' }
  if (typeof projectId === 'string' && UUID.test(projectId.trim())) {
    await emitPhase({
      phase: 'project_resolve',
      outcome: 'ok',
      duration_ms: durationMs(started),
      launch_id: launchId,
      agent,
      mcpUrl: auth.mcp_url || null,
      extra: { source: 'explicit', project_id: projectId.trim() },
    })
    return { ok: true, project_id: projectId.trim().toLowerCase(), git_remote: gitRemote, source: 'explicit' }
  }

  if (!auth?.ok || !auth.token || !auth.mcp_url) {
    await emitPhase({
      phase: 'project_resolve',
      outcome: 'error',
      duration_ms: durationMs(started),
      launch_id: launchId,
      agent,
      mcpUrl: auth?.mcp_url || null,
      reason: auth?.error || 'auth_failed',
    })
    return { ok: false, error: auth?.error || 'auth_failed', project_id: null, git_remote: gitRemote }
  }

  try {
    const result = await mcpCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'list_projects',
      arguments: {},
      timeoutMs: 60_000,
    })
    if (!Array.isArray(result?.projects)) throw new Error('DevSpec did not return accessible project choices.')
    const projects = result.projects.map(candidate)
    if (projects.some(project => !project)) throw new Error('DevSpec returned invalid project choices.')
    const matches = selectNamedProject(projects, projectId)
    const candidates = matches.length ? matches : projects
    const project_id = matches.length === 1 ? matches[0].id : null
    const source = 'explicit_name'

    if (!project_id) {
      const reason = candidates.length
        ? `ambiguous_projects:${candidates.length}`
        : gitRemote
          ? `no_project_for_remote`
          : 'no_project_match'
      await emitPhase({
        phase: 'project_resolve',
        outcome: 'error',
        duration_ms: durationMs(started),
        launch_id: launchId,
        agent,
        mcpUrl: auth.mcp_url,
        reason,
        extra: { git_remote: gitRemote, candidates: candidates.length },
      })
      return {
        ok: false,
        error: matches.length ? 'Several accessible projects have that name. Choose a project and organisation.' : 'No accessible project has that exact name. Choose from the returned projects or use a full ID.',
        code: 'project_choice_required',
        project_selection: { version: 1, status: 'choice_required', reason: matches.length ? 'ambiguous_name' : 'unknown_name', candidates },
        project_id: null,
        git_remote: gitRemote,
        candidates: candidates.map(project => project.id),
      }
    }

    await emitPhase({
      phase: 'project_resolve',
      outcome: 'ok',
      duration_ms: durationMs(started),
      launch_id: launchId,
      agent,
      mcpUrl: auth.mcp_url,
      extra: { source, project_id, git_remote: gitRemote },
    })
    return { ok: true, project_id, git_remote: gitRemote, source }
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
    await emitPhase({
      phase: 'project_resolve',
      outcome: 'error',
      duration_ms: durationMs(started),
      launch_id: launchId,
      agent,
      mcpUrl: auth.mcp_url,
      reason,
    })
    return { ok: false, error: reason, project_id: null, git_remote: gitRemote }
  }
}

/**
 * Mechanical Connect: local_id → project → register → optional attach → write/poller.
 *
 * @param {{
 *   localId?: string | null,
 *   cwd?: string,
 *   sessionId?: string | null,
 *   launchId?: string | null,
 *   projectId?: string | null,
 *   agent?: string,
 *   ownerPid?: string | number | null,
 *   noPoller?: boolean,
 *   hostToken?: string | null,
 *   codename?: string | null,
 *   forceNew?: boolean,
 *   promptText?: string | null,
 *   mcpCall?: typeof mcpToolsCall,
 *   resolveAuth?: typeof resolveDevspecMcpAuth,
 *   resolveGitRemoteFn?: typeof resolveGitRemote,
 *   emitPhase?: typeof emitConnectPhase,
 *   registerFn?: typeof registerConnection,
 *   attachFn?: typeof attachConnection,
 *   writeFn?: typeof writeConnectionState,
 *   resolveLocalFn?: typeof resolveLocalAction,
 *   detectLocalIdFn?: typeof detectLocalId,
 * }} [opts]
 */
export async function fastConnect(opts = {}) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd()
  const launchId = resolveLaunchId(opts.launchId)
  const agent = opts.agent || AGENT_NAME
  const emitPhase = opts.emitPhase || emitConnectPhase
  const mcpCall = opts.mcpCall || mcpToolsCallWithRetry
  const resolveAuth = opts.resolveAuth || resolveDevspecMcpAuth
  const resolveGitRemoteFn = opts.resolveGitRemoteFn || resolveGitRemote
  const registerFn = opts.registerFn || registerConnection
  const attachFn = opts.attachFn || attachConnection
  const writeFn = opts.writeFn || writeConnectionState
  const resolveLocalFn = opts.resolveLocalFn || resolveLocalAction
  const detectLocalIdFn = opts.detectLocalIdFn || detectLocalId

  const hostToken =
    (typeof opts.hostToken === 'string' && opts.hostToken.trim()
      ? opts.hostToken.trim()
      : null) || hostTokenFromEnv(process.env)

  let sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.length >= 8
      ? opts.sessionId
      : parseSessionIdFromPrompt(opts.promptText)

  // --- resolve_local_id ---
  const idStarted = Date.now()
  const detected = detectLocalIdFn(
    { 'local-id': opts.localId || undefined },
    {
      ...process.env,
      ...(opts.localId ? { CURSOR_CONVERSATION_ID: opts.localId } : {}),
    },
  )
  let localId = detected.local_id
  let localIdSource = detected.source
  let minted = false
  if (!localId) {
    return { ok: false, error: 'Cursor did not provide its conversation ID. Run this from Cursor or use a native create-chat ID; never substitute a folder or another host’s ID.', connection_id: null, local_id: null }
  }
  await emitPhase({
    phase: 'resolve_local_id',
    outcome: 'ok',
    duration_ms: durationMs(idStarted),
    launch_id: launchId,
    local_id: localId,
    agent,
    extra: { local_id_source: localIdSource, minted },
  })

  const auth = resolveAuth(cwd, { hostToken })
  const authFailed = () => ({
    ok: false,
    error: auth.error || 'auth_failed',
    local_id: localId,
    launch_id: launchId,
    connection_id: null,
    session_id: sessionId,
    codename: null,
  })

  let previousProject
  try { previousProject = readProjectContext(localId, auth.mcp_url || null, opts.projectHome) }
  catch (error) { return { ok: false, error: error.message, local_id: localId, connection_id: null } }
  const gitRemote = resolveGitRemoteFn(cwd)
  const prepared = await resolveProjectForConnect({ cwd, gitRemote, projectId: opts.projectId, auth, launchId, agent, mcpCall, emitPhase })
  if (!prepared.ok) {
    try { blockProjectContext(localId, auth.mcp_url, prepared.error, opts.projectHome, true) } catch {}
    return { ...prepared, local_id: localId, connection_id: null, session_id: sessionId, launch_id: launchId }
  }
  if (previousProject?.status === 'selected' && prepared.project_id && prepared.project_id !== previousProject.project.id) {
    return { ok: false, error: 'This Cursor conversation is already connected to another project. Start a fresh chat to switch.', local_id: localId, connection_id: null }
  }
  let projectContext = previousProject?.status === 'selected' ? previousProject : null

  // --- resolve_local (already_live / reconnect / register) ---
  const localStarted = Date.now()
  const localAction = resolveLocalFn({
    agent,
    localId,
    forceNew: !!opts.forceNew,
  })
  await emitPhase({
    phase: 'resolve_local',
    outcome: 'ok',
    duration_ms: durationMs(localStarted),
    launch_id: launchId,
    local_id: localId,
    connectionId: localAction.connection_id || null,
    sessionId: localAction.session_id || null,
    agent,
    mcpUrl: auth.mcp_url || null,
    extra: { action: localAction.action },
  })

  /** @type {string | null} */
  let connectionId = null
  /** @type {string | null} */
  let codename = null
  /** @type {string | null} */
  let attachedSessionId = sessionId

  if (localAction.action === 'already_live' && localAction.connection_id && projectContext && readRepositorySnapshot(localId, opts.projectHome)?.repository_context.status === 'available') {
    connectionId = localAction.connection_id
    codename = localAction.session_codename || null
    // Attach only when the launch asked for a (possibly new) session.
    if (sessionId && sessionId !== localAction.session_id) {
      if (!auth.ok) return authFailed()
      const attached = await attachFn({
        connectionId,
        sessionId,
        cwd,
        launchId,
        agent,
        hostToken,
        mcpCall,
        resolveAuth,
        emitPhase,
      })
      if (!attached.ok) {
        return {
          ok: false,
          error: attached.error || 'attach_failed',
          local_id: localId,
          launch_id: launchId,
          connection_id: connectionId,
          session_id: sessionId,
          codename,
        }
      }
      attachedSessionId = attached.session_id || sessionId
    } else {
      attachedSessionId = localAction.session_id || sessionId
    }
  } else {
    // Fresh register (and reconnect — same local_id revives the bond server-side).
    if (!auth.ok) {
      await emitPhase({
        phase: 'register_connection',
        outcome: 'error',
        duration_ms: 0,
        launch_id: launchId,
        local_id: localId,
        agent,
        mcpUrl: auth.mcp_url || null,
        reason: auth.error || 'auth_failed',
      })
      return authFailed()
    }

    const registered = await registerFn({
      localId,
      projectId: projectContext?.project.id ?? prepared.project_id,
      projectHome: opts.projectHome,
      cwd,
      launchId,
      agent,
      hostToken,
      codename: opts.codename,
      gitRemote,
      mcpCall,
      resolveAuth,
      emitPhase,
    })
    if (!registered.ok || !registered.connection_id) {
      return {
        ok: false,
        error: registered.error || 'register_failed',
        ...(registered.project_selection ? { code: 'project_choice_required', project_selection: registered.project_selection } : {}),
        local_id: localId,
        launch_id: launchId,
        connection_id: null,
        session_id: sessionId,
        codename: null,
      }
    }
    const project = candidate(registered.project_selection?.project) ?? candidate({ id: registered.project_id, name: registered.project_id })
    if (!project) return { ok: false, error: 'The registration did not confirm its project.', local_id: localId, connection_id: null }
    try {
      if (prepared.project_id && prepared.project_id !== project.id) throw new Error('DevSpec confirmed a different project than requested.')
      projectContext = selectProjectContext(localId, auth.mcp_url, project, registered.project_selection?.source ?? 'conversation', opts.projectHome)
      if (!readRepositorySnapshot(localId, opts.projectHome)) storeRepositorySnapshot(localId, registered, opts.projectHome)
    } catch (error) { return { ok: false, error: error.message, local_id: localId, connection_id: null } }
    connectionId = registered.connection_id
    codename = registered.codename || registered.session_codename || null

    if (sessionId) {
      const attached = await attachFn({
        connectionId,
        sessionId,
        cwd,
        launchId,
        agent,
        hostToken,
        mcpCall,
        resolveAuth,
        emitPhase,
      })
      if (!attached.ok) {
        return {
          ok: false,
          error: attached.error || 'attach_failed',
          local_id: localId,
          launch_id: launchId,
          connection_id: connectionId,
          session_id: sessionId,
          codename,
        }
      }
      attachedSessionId = attached.session_id || sessionId
    } else {
      // Registration also refreshes existing native conversations. Its attachment
      // snapshot is authoritative; hydration must not erase a live room bond.
      attachedSessionId = registered.session_id || null
    }
  }

  // --- write_state (+ poller) ---
  const written = await writeFn({
    connectionId,
    sessionId: attachedSessionId,
    cwd,
    launchId,
    agent,
    localId,
    ownerPid: opts.ownerPid,
    noPoller: !!opts.noPoller,
    hostToken,
    codename,
    resolveAuth,
    emitPhase,
  })
  if (!written.ok) {
    return {
      ok: false,
      error: written.error || written.warning || 'write_state_failed',
      local_id: localId,
      launch_id: launchId,
      connection_id: connectionId,
      session_id: attachedSessionId,
      codename: written.session_codename || codename,
    }
  }

  // Dense ensure_poller phase (write already started it unless noPoller deferred
  // it until after agent --resume — item f099fc6e).
  const poller = written.poller || null
  const pollerDeferred = !!(opts.noPoller || poller?.skipped)
  await emitPhase({
    phase: 'ensure_poller',
    outcome: poller?.ok || pollerDeferred ? 'ok' : 'error',
    duration_ms: 0,
    launch_id: launchId,
    local_id: localId,
    connectionId,
    sessionId: attachedSessionId,
    agent,
    mcpUrl: written.mcp_url || auth.mcp_url || null,
    reason: poller?.ok || pollerDeferred ? null : poller?.error || written.warning_poller || null,
    extra: {
      poller_pid: poller?.pid || null,
      reused: !!poller?.reused,
      skipped: !!(poller?.skipped || pollerDeferred),
      deferred_until_resume: pollerDeferred,
    },
  })

  if (poller && !poller.ok && !poller.skipped && !opts.noPoller) {
    return {
      ok: false,
      error: poller.error || written.warning_poller || 'ensure_poller_failed',
      local_id: localId,
      launch_id: launchId,
      connection_id: connectionId,
      session_id: attachedSessionId,
      codename: written.session_codename || codename,
      poller,
    }
  }

  return {
    ok: true,
    connection_id: connectionId,
    session_id: attachedSessionId,
    codename: written.session_codename || codename,
    local_id: localId,
    launch_id: launchId,
    action: localAction.action,
    project_id: projectContext?.project.id,
    project_selection: projectContext,
    project_context: readRepositorySnapshot(localId, opts.projectHome),
    project_context_file: repositoryContextTextFile(localId, opts.projectHome),
    poller,
    warning_tokens: written.warning_tokens || null,
  }
}

/**
 * CLI entry for `remote-control-state.mjs fast-connect …`.
 * @param {Record<string, unknown>} args parseArgs output
 */
export async function runFastConnectCli(args) {
  let promptText = null
  if (typeof args['prompt-file'] === 'string' && args['prompt-file']) {
    try {
      promptText = fs.readFileSync(path.resolve(String(args['prompt-file'])), 'utf8')
    } catch (err) {
      process.stderr.write(
        `fast-connect: could not read --prompt-file: ${err instanceof Error ? err.message : err}\n`,
      )
      process.exit(1)
    }
  }

  const result = await fastConnect({
    localId: typeof args['local-id'] === 'string' ? args['local-id'] : null,
    cwd: typeof args.cwd === 'string' ? args.cwd : process.cwd(),
    sessionId: typeof args.session === 'string' ? args.session : null,
    launchId: typeof args['launch-id'] === 'string' ? args['launch-id'] : null,
    projectId: typeof args['project-id'] === 'string' ? args['project-id'] : null,
    agent: typeof args.agent === 'string' ? args.agent : AGENT_NAME,
    ownerPid: args['owner-pid'] ?? null,
    noPoller: !!args.noPoller,
    hostToken: typeof args['host-token'] === 'string' ? args['host-token'] : null,
    codename: typeof args.codename === 'string' ? args.codename : null,
    forceNew: !!args.forceNew,
    promptText,
  })

  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(result.ok ? 0 : 1)
}
