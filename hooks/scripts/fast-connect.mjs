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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURSOR_SHELL_OUTPUT_MAX_CHARS, fitsShellOutput, writeNote } from './hook-context-budget.mjs'
import { mcpToolsCall, mcpToolsCallWithRetry } from './mcp-call.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
import { AGENT_NAME } from './agent-identity.mjs'
import { UUID, candidate, selectNamedProject, readProjectContext, selectProjectContext, blockProjectContext } from './project-context.mjs'
import { readRepositorySnapshot, storeRepositorySnapshot, repositoryContextTextFile, refreshRepositoryRules, renderGithubIdentity } from './repository-context.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { authForConnect } from './sign-in-flow.mjs'
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
  formatBoundedCliStderr,
  shellBudgetExceededError,
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
  const signIn = opts.signIn || authForConnect
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
    typeof opts.hostToken === 'string' && opts.hostToken.trim()
      ? opts.hostToken.trim()
      : null

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

  // The first DevSpec call of a connect: when the background features are not signed
  // in yet, this is where the one browser approval for them starts (item 95a67ee4).
  // An injected resolver (tests, native helpers) is used exactly as given.
  const auth = opts.resolveAuth ? resolveAuth(cwd, { hostToken }) : await signIn(cwd, { hostToken })
  if (!auth.ok && ['sign_in_required', 'signed_out', 'sign_in_pending', 'sign_in_code_required', 'sign_in_failed', 'sign_in_unavailable'].includes(auth.code)) {
    return {
      ok: false,
      code: auth.code,
      error: auth.error,
      ...(auth.sign_in_url ? { sign_in_url: auth.sign_in_url } : {}),
      local_id: localId,
      launch_id: launchId,
      connection_id: null,
      session_id: sessionId,
      codename: null,
    }
  }
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

    const attachTarget =
      sessionId ||
      (localAction.action === 'reconnect' && !newSession && localAction.session_id && registered.session_id !== localAction.session_id
        ? localAction.session_id
        : null)

    if (attachTarget) {
      const attached = await attachFn({
        connectionId,
        sessionId: attachTarget,
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
          session_id: attachTarget,
          codename,
        }
      }
      attachedSessionId = attached.session_id || attachTarget
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
  const repoCount = Array.isArray(projectSnapshot?.repository_context?.repositories)
    ? projectSnapshot.repository_context.repositories.length
    : null
  return {
    ok: true,
    connection_id: connectionId,
    session_id: attachedSessionId,
    codename: written.session_codename || codename,
    local_id: localId,
    launch_id: launchId,
    action: localAction.action,
    plugin_root: PLUGIN_ROOT,
    ...(createdRoom ? { new_session: true, session_url: createdRoom.session_url, title: createdRoom.title, access: makePrivate ? 'private' : 'shared' } : {}),
    project_id: projectContext?.project.id ?? null,
    ...(projectContext?.project?.name ? { project_name: projectContext.project.name } : {}),
    ...(repoCount !== null ? { repository_count: repoCount } : {}),
    ...(projectSnapshot?.github_identity ? { github_identity: projectSnapshot.github_identity } : {}),
    ...(githubStatus ? { github_status: githubStatus } : {}),
    poller,
    ...(auth.signed_in_now ? { signed_in_now: true } : {}),
  }
}

export const FAST_CONNECT_USAGE = `Usage: node remote-control-state.mjs fast-connect --owner-pid <pid> [options]

Connect this Cursor conversation to DevSpec in one command: read its conversation
id from CURSOR_CONVERSATION_ID, check existing connection state, register or
reconnect, attach to a room if asked, write its state and start its poller.

  --local-id <id>          Optional override for CURSOR_CONVERSATION_ID.
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
  --codename <name>        This agent's codename instead of a minted one. --name is the same.
  -h, --help               Print this help and exit. Connects nothing.

Prints one short JSON result; exits 0 when connected, 1 when not.
`

/**
 * Format fast-connect CLI JSON within Cursor's Shell output ceiling (`fitsShellOutput`,
 * `hook-context-budget.mjs`). Drops the duplicate top-level `candidates` ID array when
 * `project_selection.candidates` already carries the structured candidates, and when a
 * large choice list still exceeds Cursor's ceiling, writes the complete, uncut JSON to
 * a sealed note (`writeNote`) and returns a compact structured refusal naming that note
 * so Cursor never slices the choices in half (requirements 3c5147a7, 91d7b47c, 4e32d1a5).
 */
function buildBoundedFastConnectNoteReceipt(normalized, noteRef, fullTextLength, { reserve = '' } = {}) {
  const base =
    normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      ? { ...normalized }
      : { ok: false }
  const selection = base.project_selection
  const candidateCount = Array.isArray(selection?.candidates) ? selection.candidates.length : null
  if (selection && typeof selection === 'object') {
    const { candidates: _omit, ...selectionRest } = selection
    base.project_selection = {
      ...selectionRest,
      ...(candidateCount !== null ? { candidate_count: candidateCount } : {}),
      omitted_inline: true,
      complete_in_note: noteRef,
    }
  }
  if (Array.isArray(base.candidates)) {
    base.candidate_count = base.candidates.length
    delete base.candidates
  }
  const noteMsg = `Full connect output (${fullTextLength} chars) exceeds Cursor's ${CURSOR_SHELL_OUTPUT_MAX_CHARS}-char Shell limit and was saved whole to a note. Run \`${noteRef.command}\` (and every further part it names) to read all details.`
  base.complete_output_note = noteRef
  base.note = noteMsg
  const richText = JSON.stringify(base, null, 2) + '\n'
  if (fitsShellOutput(`${reserve}${richText}`)) return richText

  const minimal = {
    ok: Boolean(base.ok),
    ...(typeof base.code === 'string' ? { code: base.code } : {}),
    ...(typeof base.connection_id === 'string' ? { connection_id: base.connection_id } : {}),
    ...(typeof base.session_id === 'string' ? { session_id: base.session_id } : {}),
    ...(typeof base.local_id === 'string' ? { local_id: base.local_id } : {}),
    ...(typeof base.project_id === 'string' ? { project_id: base.project_id } : {}),
    ...(selection && typeof selection === 'object'
      ? {
          project_selection: {
            ...(selection.version !== undefined ? { version: selection.version } : {}),
            ...(typeof selection.status === 'string' ? { status: selection.status } : {}),
            ...(typeof selection.reason === 'string' ? { reason: selection.reason } : {}),
            ...(candidateCount !== null ? { candidate_count: candidateCount } : {}),
            omitted_inline: true,
            complete_in_note: noteRef,
          },
        }
      : {}),
    omitted_fields_in_note: true,
    complete_output_note: noteRef,
    note: noteMsg,
  }
  const minimalText = JSON.stringify(minimal, null, 2) + '\n'
  if (fitsShellOutput(`${reserve}${minimalText}`)) return minimalText

  // Final guaranteed-bounded receipt when caller-supplied identifier fields or prior stderr
  // leave minimal room inside Cursor's Shell ceiling (reqs 3c5147a7 / 91d7b47c). Never drop
  // the note pointer or return an empty string silently: refuse explicitly if reserve itself
  // leaves too little room for the smallest visible pointer.
  const compactReceipt =
    JSON.stringify(
      {
        ok: Boolean(base.ok),
        ...(candidateCount !== null
          ? { candidate_count: candidateCount, returned_count: 0, omitted_count: candidateCount }
          : {}),
        omitted_fields_in_note: true,
        complete_output_note: noteRef,
        note: noteMsg,
      },
      null,
      2,
    ) + '\n'
  if (fitsShellOutput(`${reserve}${compactReceipt}`)) return compactReceipt
  const tightReceipt = `${JSON.stringify({
    ok: Boolean(base.ok),
    ...(candidateCount !== null
      ? { candidate_count: candidateCount, returned_count: 0, omitted_count: candidateCount }
      : {}),
    note: noteRef.id,
    read: noteRef.command,
    parts: noteRef.parts,
  })}\n`
  if (fitsShellOutput(`${reserve}${tightReceipt}`)) return tightReceipt
  throw shellBudgetExceededError({
    field: 'reserve',
    reserveLength: String(reserve ?? '').length,
    requiredLength: tightReceipt.length,
    fullTextLength,
    note: noteRef,
    candidateCount,
  })
}

function buildFastConnectNoteFailureFallback(normalized, noteError, fullTextLength, { reserve = '' } = {}) {
  const base =
    normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      ? { ...normalized }
      : { ok: false }
  const selection =
    base.project_selection && typeof base.project_selection === 'object' ? base.project_selection : null
  const allCandidates = Array.isArray(selection?.candidates) ? selection.candidates : null
  const errMsg = noteError instanceof Error ? noteError.message : String(noteError)
  const recovery = allCandidates
    ? `Could not write ~/.devspec/notes (${errMsg}). Fix write permissions on ~/.devspec/notes and re-run connect so all ${allCandidates.length} server-matched project choices can be saved whole and read back (or pass --project <id> directly if you already know the project ID).`
    : `Could not write ~/.devspec/notes (${errMsg}). Fix write permissions on ~/.devspec/notes and re-run connect to read the full ${fullTextLength}-char output.`

  const makePayload = (candidateSlice, { minimal = false } = {}) => {
    const out = minimal
      ? {
          ok: Boolean(base.ok),
          ...(typeof base.code === 'string' ? { code: base.code } : {}),
          ...(typeof base.connection_id === 'string' ? { connection_id: base.connection_id } : {}),
          ...(typeof base.session_id === 'string' ? { session_id: base.session_id } : {}),
          ...(typeof base.local_id === 'string' ? { local_id: base.local_id } : {}),
          ...(typeof base.project_id === 'string' ? { project_id: base.project_id } : {}),
          omitted_fields_due_to_shell_limit: true,
        }
      : { ...base }
    if (Array.isArray(out.candidates)) {
      out.candidate_count = out.candidates.length
      delete out.candidates
    }
    if (selection) {
      const { candidates: _omit, ...selectionRest } = selection
      const selBase = minimal
        ? {
            ...(selection.version !== undefined ? { version: selection.version } : {}),
            ...(typeof selection.status === 'string' ? { status: selection.status } : {}),
            ...(typeof selection.reason === 'string' ? { reason: selection.reason } : {}),
          }
        : selectionRest
      out.project_selection = {
        ...selBase,
        ...(allCandidates
          ? {
              candidates: candidateSlice,
              candidate_count: allCandidates.length,
              returned_count: candidateSlice.length,
              omitted_count: allCandidates.length - candidateSlice.length,
              truncated_due_to_shell_limit: candidateSlice.length < allCandidates.length,
              omitted_candidates_require_writable_notes: candidateSlice.length < allCandidates.length,
            }
          : {}),
      }
    }
    out.complete_output_note_error = errMsg
    out.total_chars = fullTextLength
    out.shell_limit_chars = CURSOR_SHELL_OUTPUT_MAX_CHARS
    out.recovery = recovery
    return JSON.stringify(out, null, 2) + '\n'
  }

  const useMinimal = !fitsShellOutput(`${reserve}${makePayload([], { minimal: false })}`)
  if (allCandidates && allCandidates.length > 0) {
    let lo = 0
    let hi = allCandidates.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fitsShellOutput(`${reserve}${makePayload(allCandidates.slice(0, mid), { minimal: useMinimal })}`)) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    const text = makePayload(allCandidates.slice(0, lo), { minimal: useMinimal })
    if (fitsShellOutput(`${reserve}${text}`)) return text
  } else {
    const text = makePayload([], { minimal: useMinimal })
    if (fitsShellOutput(`${reserve}${text}`)) return text
  }

  const fallbackObj = {
    ok: Boolean(base.ok),
    ...(allCandidates
      ? {
          candidate_count: allCandidates.length,
          returned_count: 0,
          omitted_count: allCandidates.length,
          omitted_candidates_require_writable_notes: true,
        }
      : {}),
    complete_output_note_failed: true,
    total_chars: fullTextLength,
    shell_limit_chars: CURSOR_SHELL_OUTPUT_MAX_CHARS,
    recovery: allCandidates
      ? 'Could not write ~/.devspec/notes. Fix write permissions on ~/.devspec/notes and re-run connect so all server-matched project choices can be saved whole and read back (or pass --project <id> directly).'
      : 'Could not write ~/.devspec/notes. Fix write permissions on ~/.devspec/notes and re-run connect.',
  }
  const fallbackReceipt = JSON.stringify(fallbackObj, null, 2) + '\n'
  if (fitsShellOutput(`${reserve}${fallbackReceipt}`)) return fallbackReceipt
  // Single-line compact form preserves every required count, limit, and recovery field
  // (requirements 3c5147a7 / 91d7b47c). If reserve leaves too little room even for that,
  // refuse explicitly with field, limit, actual length, counts, and recovery.
  const compactFallback = `${JSON.stringify(fallbackObj)}\n`
  if (fitsShellOutput(`${reserve}${compactFallback}`)) return compactFallback
  throw shellBudgetExceededError({
    field: 'reserve',
    reserveLength: String(reserve ?? '').length,
    requiredLength: compactFallback.length,
    fullTextLength,
    noteFailed: true,
    candidateCount: allCandidates ? allCandidates.length : null,
    recovery: fallbackObj.recovery,
  })
}

export function formatFastConnectCliOutput(result, { home = os.homedir(), reserve = '' } = {}) {
  const normalized =
    result && typeof result === 'object' && !Array.isArray(result) ? { ...result } : result
  if (
    normalized &&
    typeof normalized === 'object' &&
    Array.isArray(normalized.project_selection?.candidates) &&
    Array.isArray(normalized.candidates)
  ) {
    delete normalized.candidates
  }
  const fullText = JSON.stringify(normalized, null, 2) + '\n'
  if (fitsShellOutput(`${reserve}${fullText}`)) return fullText

  let note = null
  let noteError = null
  try {
    note = writeNote(fullText, { home })
  } catch (error) {
    noteError = error
  }
  if (!note) {
    return buildFastConnectNoteFailureFallback(normalized, noteError, fullText.length, { reserve })
  }
  const noteRef = {
    id: note.id,
    command: note.command,
    parts: note.parts,
    total_chars: fullText.length,
    shell_limit_chars: CURSOR_SHELL_OUTPUT_MAX_CHARS,
  }
  return buildBoundedFastConnectNoteReceipt(normalized, noteRef, fullText.length, { reserve })
}

/**
 * Write `text` to `stream` and wait for Node to flush every byte to the underlying
 * file descriptor before returning (so `process.exit()` never truncates output on a
 * backpressured pipe — requirements 3c5147a7 / 91d7b47c / 4e32d1a5).
 */
export function writeStreamAndFlush(stream, text) {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      stream.off('error', done)
      resolve()
    }
    stream.once('error', done)
    stream.write(text, done)
  })
}

/**
 * CLI entry for `remote-control-state.mjs fast-connect …`.
 * @param {Record<string, unknown>} args parseArgs output
 * @param {{ getEmittedStderr?: () => string }} [opts]
 */
export async function runFastConnectCli(args, { getEmittedStderr = null } = {}) {
  let localStderr = ''
  const origStderrWrite = getEmittedStderr ? null : process.stderr.write.bind(process.stderr)
  if (origStderrWrite) {
    process.stderr.write = (chunk, ...rest) => {
      localStderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return origStderrWrite(chunk, ...rest)
    }
  }
  const currentStderr = () => (getEmittedStderr ? getEmittedStderr() : localStderr)
  try {
    // Help is read before anything else: it registers, writes and calls nothing.
    if (args.help || (Array.isArray(args._) && args._.slice(1).includes('help'))) {
      await writeStreamAndFlush(process.stdout, FAST_CONNECT_USAGE)
      process.exit(0)
    }

    let promptText = null
    if (typeof args['prompt-file'] === 'string' && args['prompt-file']) {
      const rawPromptFile = String(args['prompt-file'])
      try {
        promptText = fs.readFileSync(path.resolve(rawPromptFile), 'utf8')
      } catch (err) {
        const errCode = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'read_failed'
        const detail = err instanceof Error ? err.message : String(err)
        const rawDiag = `fast-connect: could not read --prompt-file: ${detail}\n`
        const summary = `could not read --prompt-file (field --prompt-file, actual_length ${rawPromptFile.length}, shell_limit_chars ${CURSOR_SHELL_OUTPUT_MAX_CHARS}, code ${errCode})`
        const bounded = formatBoundedCliStderr(rawDiag, {
          label: 'fast-connect',
          reserve: currentStderr(),
          summary,
          fallback: `fast-connect: ${summary}; full error omitted because stderr + note fallback could not fit Cursor's Shell ceiling.\n`,
        })
        await writeStreamAndFlush(process.stderr, bounded)
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

    await writeStreamAndFlush(
      process.stdout,
      formatFastConnectCliOutput(result, { reserve: currentStderr() }),
    )
    process.exit(result.ok ? 0 : 1)
  } finally {
    if (origStderrWrite) process.stderr.write = origStderrWrite
  }
}
