/**
 * Mechanical Cursor Connect (item 1cc2a2d5): register, optionally attach and
 * write the current native conversation's state. A poller needs a durable host
 * owner PID (item f099fc6e). This is plugin connection machinery, not the
 * independent DevSpec Launcher.
 *
 * Usage (CLI via remote-control-state.mjs; `fast-connect --help` prints it):
 *   node remote-control-state.mjs fast-connect --local-id <id> --owner-pid <pid>
 *       [--session <uuid> | --new [--private] [--title <text>]]
 *       [--cwd <path>] [--launch-id <uuid>] [--project <name-or-id>] [--prompt-file <path>]
 *
 * Native host helpers may also import fastConnect directly.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mcpToolsCall, mcpToolsCallWithRetry } from './mcp-call.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { UUID, candidate, selectNamedProject, readProjectContext, selectProjectContext, blockProjectContext } from './project-context.mjs'
import { readRepositorySnapshot, storeRepositorySnapshot, repositoryContextTextFile, refreshRepositoryRules, renderGithubIdentity } from './repository-context.mjs'
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
  /(?:project_id|automation_id|run_id|connection_id|local_id|launch_id|automation_run_id|task_id|item_id)\s*=\s*$/i

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
  // The skill's own name, not the helper scripts that share its prefix
  // (devspec-remote-wait.mjs --connection-id <uuid> names a connection, not a room).
  const lower = promptBody.toLowerCase()
  if (
    /devspec-remote(?![\w-])/.test(lower) ||
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
    const reason = err instanceof Error ? err.message : String(err)
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
 * `--new`: open a room in the confirmed project for this connection. It is an
 * ordinary shared room unless `--private` asked for one only the person can open.
 * Called once, without the connect retry: a create is not idempotent, so a retried
 * one whose first attempt landed would leave a second, empty room behind.
 * @returns {Promise<{ ok: true, session_id: string, session_url: string | null, title: string | null } | { ok: false, error: string }>}
 */
async function createRoomForConnection({ auth, agent, projectId, title, codename, makePrivate, mcpCall }) {
  if (!auth?.ok || !auth.token || !auth.mcp_url) return { ok: false, error: auth?.error || 'auth_failed' }
  if (!projectId) return { ok: false, error: 'The connection has no confirmed project to open the room in.' }
  try {
    const created = await mcpCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'create_session',
      arguments: {
        session_type: 'agent_remote_control',
        access: makePrivate ? 'private' : 'shared',
        agent_name: agent,
        project_id: projectId,
        ...(title ? { title } : {}),
        ...(codename ? { session_codename: codename } : {}),
      },
      timeoutMs: 60_000,
    })
    const sessionId = [created?.session_id, created?.id].find(id => typeof id === 'string' && id.trim())
    if (!sessionId) return { ok: false, error: 'DevSpec returned no session id for the new room.' }
    return {
      ok: true,
      session_id: sessionId.trim(),
      session_url: typeof created.session_url === 'string' ? created.session_url : null,
      title: typeof created.title === 'string' ? created.title : title || null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Mechanical Connect: local_id → project → register → optional attach → write/poller.
 * With `newSession` (`--new`), the attach target is a room created for this
 * connection after it is registered (or found already live).
 *
 * @param {{
 *   localId?: string | null,
 *   cwd?: string,
 *   sessionId?: string | null,
 *   newSession?: boolean,
 *   title?: string | null,
 *   private?: boolean,
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
  const attachFn = async args => {
    const attached = await (opts.attachFn || attachConnection)({...args,localId,projectHome:opts.projectHome})
    if(attached.ok) refreshRepositoryRules(localId,attached,opts.projectHome)
    return attached
  }
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
  const newSession = !!opts.newSession
  const makePrivate = !!opts.private
  const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : null
  if (newSession && sessionId) {
    return {
      ok: false,
      code: 'new_with_session',
      error: '--new opens a new room and --session attaches to an existing one. Pass one or the other, not both.',
      local_id: null,
      connection_id: null,
      session_id: null,
    }
  }
  if (makePrivate && !newSession) {
    return {
      ok: false,
      code: 'private_without_new',
      error: sessionId
        ? '--private does nothing with --session: it only applies to the room --new opens. Nothing was connected.'
        : '--private does nothing without --new: it only applies to the room --new opens. Nothing was connected.',
      local_id: null,
      connection_id: null,
      session_id: null,
    }
  }

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

  // --- --new: create the room, then attach exactly as --session does ---
  /** @type {{ session_id: string, session_url: string | null, title: string | null } | null} */
  let createdRoom = null
  if (newSession) {
    const created = await createRoomForConnection({
      auth,
      agent,
      projectId: projectContext?.project.id ?? null,
      title,
      codename,
      makePrivate,
      mcpCall: opts.mcpCall || mcpToolsCall,
    })
    if (!created.ok) {
      return {
        ok: false,
        code: 'create_session_failed',
        error: `create_session_failed: ${created.error}`,
        local_id: localId,
        launch_id: launchId,
        connection_id: connectionId,
        session_id: null,
        codename,
      }
    }
    const attached = await attachFn({
      connectionId,
      sessionId: created.session_id,
      cwd,
      launchId,
      agent,
      hostToken,
      mcpCall,
      resolveAuth,
      emitPhase,
    })
    if (!attached.ok) {
      // The room exists but this connection is not in it: name it, never claim it.
      return {
        ok: false,
        code: 'attach_failed',
        error: `attach_failed: ${attached.error || 'attach_connection failed'}`,
        local_id: localId,
        launch_id: launchId,
        connection_id: connectionId,
        session_id: null,
        created_session_id: created.session_id,
        codename,
      }
    }
    attachedSessionId = attached.session_id || created.session_id
    createdRoom = created
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
    ...(createdRoom?.title ? { title: createdRoom.title } : {}),
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

  const projectSnapshot = readRepositorySnapshot(localId, opts.projectHome)
  const githubStatus = renderGithubIdentity(projectSnapshot?.github_identity)
  return {
    ok: true,
    connection_id: connectionId,
    session_id: attachedSessionId,
    codename: written.session_codename || codename,
    local_id: localId,
    launch_id: launchId,
    action: localAction.action,
    ...(createdRoom ? { new_session: true, session_url: createdRoom.session_url, title: createdRoom.title, access: makePrivate ? 'private' : 'shared' } : {}),
    project_id: projectContext?.project.id,
    project_selection: projectContext,
    project_context: projectSnapshot,
    project_context_file: repositoryContextTextFile(localId, opts.projectHome),
    ...(projectSnapshot?.github_identity ? { github_identity: projectSnapshot.github_identity } : {}),
    ...(githubStatus ? { github_status: githubStatus } : {}),
    poller,
    warning_tokens: written.warning_tokens || null,
  }
}

export const FAST_CONNECT_USAGE = `Usage: node remote-control-state.mjs fast-connect --local-id <id> --owner-pid <pid> [options]

Connect this Cursor conversation to DevSpec in one command: register it, attach
it to a room if asked, write its state and start its poller.

  --local-id <id>          This conversation's id (CURSOR_CONVERSATION_ID).
  --agent <name>           Agent name shown in DevSpec. Default: Cursor.
  --cwd <path>             The working folder. Default: the current directory.
  --owner-pid <pid>        The Cursor process this connection belongs to; pass "$PPID".
                           The poller does not start without it.
  --session <uuid>         Attach to this existing room.
  --new                    Open a new room for this conversation and attach to it.
                           Shared with the project. Not with --session.
  --private                With --new only: open the room so that only you can see it.
  --title <text>           With --new: the new room's title.
  --project <name-or-id>   Choose this conversation's project. --project-id is the same.
  --launch-id <uuid>       The launch id stamped in the prompt, for local diagnostics.
  --codename <name>        This agent's codename instead of a minted one.
  -h, --help               Print this help and exit. Connects nothing.

Prints one JSON result; exits 0 when connected, 1 when not.
`

/**
 * CLI entry for `remote-control-state.mjs fast-connect …`.
 * @param {Record<string, unknown>} args parseArgs output
 */
export async function runFastConnectCli(args) {
  // Help is read before anything else: it registers, writes and calls nothing.
  if (args.help || (Array.isArray(args._) && args._.slice(1).includes('help'))) {
    process.stdout.write(FAST_CONNECT_USAGE)
    process.exit(0)
  }

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
    newSession: !!args.new,
    title: typeof args.title === 'string' ? args.title : null,
    private: !!args.private,
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
