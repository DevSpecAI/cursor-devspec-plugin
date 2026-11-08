/**
 * Signing the background features in and out, item 95a67ee4: the steps behind
 * scripts/devspec-login.mjs and behind /devspec-remote's first connect.
 *
 * - A new sign-in is confirmed with DevSpec at the very server it was approved for
 *   before it is saved, so a saved login is always one that worked.
 * - The browser approval runs in ONE detached helper per server (auth-store.mjs
 *   markers), which owns the loopback listener for up to ten minutes. Whoever asked
 *   (the connect helper, the login command) only waits on the local login file.
 * - Where the browser cannot reach this machine, the person copies a code from
 *   DevSpec's page and pastes it back; the PKCE verifier waits on this machine.
 */

import readline from 'node:readline'
import {
  beginBackgroundSignIn,
  clearCodeSignIn,
  finishPendingSignIn,
  livePendingSignIn,
  loginState,
  readCodeSignIn,
  recordPendingSignIn,
  removeLogin,
  renewLogin,
  saveCodeSignIn,
  saveLogin,
  waitForBackgroundSignIn,
} from './auth-store.mjs'
import { codePageUrl, configuredMcpUrl, mcpUrlForServer, serverLabel } from './devspec-server.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  envTokenNotice,
  envTokenShadowsLogin,
  hostTokenFromEnv,
  loginCommandFor,
  loginEndedMessage,
  resolveDevspecMcpAuth,
  TOKEN_ENV_VAR,
} from './resolve-mcp-auth.mjs'
import {
  CURSOR_CLIENT_IDS,
  SIGN_IN_WAIT_MS,
  SignInError,
  browserCanReachThisMachine,
  clientIdFor,
  completeCopyCodeSignIn,
  discoverSignIn,
  openInBrowser,
  prepareCopyCodeSignIn,
  revokeRefreshToken,
  startLoopbackSignIn,
} from './sign-in.mjs'

/** How long /devspec-remote waits for the person to click Allow before handing back. */
export const CONNECT_SIGN_IN_WAIT_MS = 120_000

const message = (err) => (err instanceof Error ? err.message : String(err))

function readableName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || /^[{[]/.test(name) || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null
  return name
}

/** Who DevSpec says a credential acts as, from verify_agent_connection's structured fields only. */
export function signedInAsFrom(data) {
  if (!data || typeof data !== 'object') return null
  for (const key of ['connected_as', 'name', 'user_name', 'display_name', 'email']) {
    const name = readableName(data[key])
    if (name) return name
  }
  return data.user && typeof data.user === 'object' ? readableName(data.user.name) ?? readableName(data.user.email) : null
}

/**
 * Confirm DevSpec accepts the new sign-in at the server it was approved for, then
 * save it under that server. A sign-in DevSpec refuses is canceled at Clerk and never
 * saved.
 */
export async function verifyAndSave({ mcpUrl, discovery, clientId, tokens }, { call = mcpToolsCall, fetchImpl = fetch, home } = {}) {
  let data
  try {
    data = await call({ mcpUrl, token: tokens.accessToken, name: 'verify_agent_connection', arguments: {}, timeoutMs: 30_000 })
  } catch (err) {
    await revokeRefreshToken({ revocationEndpoint: discovery.revocationEndpoint, clientId, refreshToken: tokens.refreshToken }, fetchImpl)
    throw new SignInError(`DevSpec did not accept the new sign-in: ${message(err)}`)
  }
  return saveLogin({
    mcpUrl,
    tokens,
    issuer: discovery.issuer,
    tokenEndpoint: discovery.tokenEndpoint,
    revocationEndpoint: discovery.revocationEndpoint,
    clientId,
    resource: discovery.resource,
    signedInAs: signedInAsFrom(data) ?? undefined,
  }, home ? { home } : {})
}

/**
 * The detached helper's whole job (scripts/devspec-login.mjs --background): open the
 * approval, listen on 127.0.0.1 for the browser's answer for up to ten minutes, then
 * confirm and save the login. Its outcome is left beside the login file for whoever
 * is waiting.
 */
export async function runBackgroundSignIn(mcpUrl, { fetchImpl = fetch, call = mcpToolsCall, open = openInBrowser, home, waitMs = SIGN_IN_WAIT_MS, clientIds = CURSOR_CLIENT_IDS } = {}) {
  const opts = home ? { home } : {}
  try {
    const discovery = await discoverSignIn(mcpUrl, fetchImpl)
    const clientId = clientIdFor(discovery.issuer, clientIds)
    const pending = await startLoopbackSignIn({ discovery, clientId, waitMs }, fetchImpl)
    recordPendingSignIn(mcpUrl, { pid: process.pid, url: pending.url }, opts)
    open(pending.url)
    const tokens = await pending.done
    const login = await verifyAndSave({ mcpUrl, discovery, clientId, tokens }, { call, fetchImpl, home })
    finishPendingSignIn(mcpUrl, { outcome: 'signed_in', signedInAs: login.signedInAs ?? null }, opts)
    return { ok: true, login }
  } catch (err) {
    finishPendingSignIn(mcpUrl, { outcome: 'failed', error: message(err) }, opts)
    return { ok: false, error: message(err) }
  }
}

/** Start a copy-a-code sign-in: the link to open, with the verifier kept on this machine. */
export async function startCodeSignIn(mcpUrl, { fetchImpl = fetch, home, clientIds = CURSOR_CLIENT_IDS } = {}) {
  const discovery = await discoverSignIn(mcpUrl, fetchImpl)
  const clientId = clientIdFor(discovery.issuer, clientIds)
  const { url, pending } = prepareCopyCodeSignIn({ discovery, clientId, codePageUrl: codePageUrl(mcpUrl) })
  saveCodeSignIn(mcpUrl, pending, home ? { home } : {})
  return { url }
}

/** Finish a copy-a-code sign-in with the `code#state` the person pasted. */
export async function finishCodeSignIn(mcpUrl, pasted, { fetchImpl = fetch, call = mcpToolsCall, home } = {}) {
  const opts = home ? { home } : {}
  const pending = readCodeSignIn(mcpUrl, opts)
  if (!pending) throw new SignInError(`No sign-in is waiting for a code for DevSpec (${serverLabel(mcpUrl)}), or it is more than ten minutes old. Start again with ${loginCommandFor(mcpUrl)} --code.`)
  const tokens = await completeCopyCodeSignIn(pending, pasted, fetchImpl)
  clearCodeSignIn(mcpUrl, opts)
  return verifyAndSave({ mcpUrl, discovery: pending.discovery, clientId: pending.clientId, tokens }, { call, fetchImpl, home })
}

/** Sign one server out: forget its login here and cancel it at Clerk (best effort). */
export async function signOut(mcpUrl, { fetchImpl = fetch, home } = {}) {
  const removed = await removeLogin(mcpUrl, home ? { home } : {})
  if (removed) {
    await revokeRefreshToken({ revocationEndpoint: removed.revocationEndpoint, clientId: removed.clientId, refreshToken: removed.refreshToken }, fetchImpl)
  }
  return removed
}

/**
 * The credential for /devspec-remote's first DevSpec call, signing the background
 * features in first when they are not: one browser approval, which names Cursor.
 *
 * Waits up to `waitMs` for the person to click Allow, reading only the local login
 * file. If they have not yet, hands back `code: 'sign_in_pending'` with the link; the
 * approval stays open for ten minutes, so running /devspec-remote again after
 * approving connects without a second approval.
 */
export async function authForConnect(cwd, {
  hostToken = null,
  env = process.env,
  home,
  waitMs = CONNECT_SIGN_IN_WAIT_MS,
  report = (line) => process.stderr.write(`${line}\n`),
  begin = beginBackgroundSignIn,
  wait = waitForBackgroundSignIn,
  startCode = startCodeSignIn,
  canReach = browserCanReachThisMachine,
} = {}) {
  const opts = { env, ...(home ? { home } : {}), ...(hostToken ? { hostToken } : {}) }
  const storeOpts = home ? { home } : {}
  let auth = resolveDevspecMcpAuth(cwd, opts)
  const withNotice = (result) => (envTokenShadowsLogin(opts) ? { ...result, warning_env_token: envTokenNotice() } : result)
  if (auth.ok || !['sign_in_required', 'signed_out'].includes(auth.code)) return withNotice(auth)
  const mcpUrl = auth.mcp_url
  const label = serverLabel(mcpUrl)

  if (!canReach(env)) {
    try {
      const { url } = await startCode(mcpUrl, storeOpts)
      return {
        ...auth,
        code: 'sign_in_code_required',
        sign_in_url: url,
        error: `Remote control and commit tracking need your OK for Cursor in DevSpec (${label}). This machine cannot receive your browser's answer directly (it is reached over SSH), so: open ${url} in your browser, approve Cursor, and copy the code the page shows. ` +
          `Then run ${loginCommandFor(mcpUrl)} --paste "<the code>" and run /devspec-remote again.`,
      }
    } catch (err) {
      return { ...auth, code: 'sign_in_failed', error: `DevSpec sign-in unavailable: ${message(err)}` }
    }
  }

  const started = begin(mcpUrl, storeOpts)
  if (started.status === 'failed') return { ...auth, code: 'sign_in_failed', error: `DevSpec sign-in unavailable: ${started.error}` }
  if (started.status !== 'signed_in') {
    const link = started.url ? ` If it did not open, open this link: ${started.url}` : ''
    report(`DevSpec: approve Cursor in your browser to turn on remote control and commit tracking (${label}).${link}`)
    const done = await wait(mcpUrl, { since: started.startedAt, timeoutMs: waitMs, ...storeOpts })
    if (done.status === 'failed') return { ...auth, code: 'sign_in_failed', error: `DevSpec sign-in did not finish: ${done.error} Run /devspec-remote to try again.` }
    if (done.status !== 'signed_in') {
      const url = done.url ?? started.url
      return {
        ...auth,
        code: 'sign_in_pending',
        ...(url ? { sign_in_url: url } : {}),
        error: `Still waiting for your OK in the browser. Approve Cursor on DevSpec's page${url ? ` (${url})` : ''}, then run /devspec-remote again. The page stays valid for ten minutes.`,
      }
    }
  }
  auth = resolveDevspecMcpAuth(cwd, opts)
  return auth.ok ? { ...withNotice(auth), signed_in_now: true } : auth
}

// --- The login command -----------------------------------------------------------

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer) }))
}

/** `scripts/devspec-login.mjs`: sign in, sign out, or say where things stand. Returns an exit code. */
export async function loginCommandMain(argv = process.argv.slice(2), { env = process.env, out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
  const valueOf = (name) => {
    const at = argv.indexOf(name)
    return at >= 0 && typeof argv[at + 1] === 'string' && !argv[at + 1].startsWith('--') ? argv[at + 1] : null
  }
  const server = valueOf('--server')
  const mcpUrl = server ? mcpUrlForServer(server, env) : configuredMcpUrl(env)
  const label = serverLabel(mcpUrl)

  if (flags.has('--help')) {
    out([
      'Sign DevSpec\'s background features for Cursor (remote control, commit tracking) in or out.',
      '',
      `  ${loginCommandFor(mcpUrl)}             sign in through your browser`,
      `  ${loginCommandFor(mcpUrl)} --code      sign in on a machine your browser cannot reach`,
      `  ${loginCommandFor(mcpUrl)} --status    show the server and who the plugin is signed in as`,
      `  ${loginCommandFor(mcpUrl)} --sign-out  sign out of this server only`,
      '',
      'The server is the one the plugin uses: production, or DEVSPEC_API_URL / DEVSPEC_MCP_URL when set.',
    ].join('\n'))
    return 0
  }

  if (flags.has('--renew')) {
    const result = await renewLogin(mcpUrl)
    return result.status === 'failed' ? 1 : 0
  }
  if (flags.has('--background')) {
    const result = await runBackgroundSignIn(mcpUrl)
    return result.ok ? 0 : 1
  }

  if (flags.has('--status')) {
    const state = loginState(mcpUrl)
    const lines = [`DevSpec server: ${label} (${mcpUrl})`]
    if (hostTokenFromEnv(env)) lines.push(`Using the token in ${TOKEN_ENV_VAR}.`, envTokenNotice())
    if (state.kind === 'active') lines.push(`Signed in through the browser${state.login.signedInAs ? ` as ${state.login.signedInAs}` : ''}.`)
    else if (state.kind === 'ended') lines.push(loginEndedMessage(mcpUrl))
    else if (!hostTokenFromEnv(env)) lines.push(`Not signed in. Run ${loginCommandFor(mcpUrl)} to sign in.`)
    const pending = livePendingSignIn(mcpUrl)
    if (pending?.url) lines.push(`A browser approval is waiting: ${pending.url}`)
    out(lines.join('\n'))
    return 0
  }

  if (flags.has('--sign-out')) {
    const removed = await signOut(mcpUrl)
    out(`${removed ? `Signed Cursor's background features out of DevSpec (${label}).` : `Cursor's background features were not signed in to DevSpec (${label}).`}` +
      (hostTokenFromEnv(env) ? ` ${envTokenNotice()}` : ''))
    return 0
  }

  // Signing in. A token in the environment would win over the new login on the very
  // next start, so refuse rather than report a success that would be ignored.
  if (hostTokenFromEnv(env)) {
    out(envTokenNotice())
    return 1
  }

  const pasted = valueOf('--paste')
  if (flags.has('--paste')) {
    if (!pasted) {
      out('Paste the whole code the DevSpec page showed, for example: --paste "abc123#xyz".')
      return 2
    }
    try {
      const login = await finishCodeSignIn(mcpUrl, pasted)
      out(`Signed in to DevSpec (${label})${login.signedInAs ? ` as ${login.signedInAs}` : ''}. Remote control and commit tracking can now use it.`)
      return 0
    } catch (err) {
      out(`DevSpec sign-in failed: ${message(err)}`)
      return 1
    }
  }

  if (flags.has('--code') || !browserCanReachThisMachine(env)) {
    let url
    try {
      ({ url } = await startCodeSignIn(mcpUrl))
    } catch (err) {
      out(`DevSpec sign-in unavailable: ${message(err)}`)
      return 1
    }
    out(`Sign in to DevSpec (${label}): open this link in a browser, approve Cursor, then copy the code the page shows.\n${url}`)
    if (!process.stdin.isTTY) {
      out(`Then run: ${loginCommandFor(mcpUrl)} --paste "<the code>"`)
      return 0
    }
    const answer = (await ask('Paste the code from the DevSpec page: ')).trim()
    if (!answer) {
      out('DevSpec sign-in canceled.')
      return 1
    }
    try {
      const login = await finishCodeSignIn(mcpUrl, answer)
      out(`Signed in to DevSpec (${label})${login.signedInAs ? ` as ${login.signedInAs}` : ''}. Remote control and commit tracking can now use it.`)
      return 0
    } catch (err) {
      out(`DevSpec sign-in failed: ${message(err)}`)
      return 1
    }
  }

  const started = beginBackgroundSignIn(mcpUrl)
  if (started.status === 'failed') {
    out(`DevSpec sign-in unavailable: ${started.error}`)
    return 1
  }
  if (started.status !== 'signed_in') {
    out(`Approve Cursor in your browser to sign in to DevSpec (${label}).${started.url ? ` If it did not open, open this link:\n${started.url}` : ''}\n` +
      `On a machine your browser cannot reach, run ${loginCommandFor(mcpUrl)} --code instead.`)
    const done = await waitForBackgroundSignIn(mcpUrl, { since: started.startedAt, timeoutMs: SIGN_IN_WAIT_MS + 30_000 })
    if (done.status !== 'signed_in') {
      out(`DevSpec sign-in did not finish: ${done.status === 'failed' ? done.error : 'nobody approved it in time.'} Run ${loginCommandFor(mcpUrl)} to try again.`)
      return 1
    }
  }
  const state = loginState(mcpUrl)
  out(`Signed in to DevSpec (${label})${state.login?.signedInAs ? ` as ${state.login.signedInAs}` : ''}. Remote control and commit tracking can now use it.`)
  return 0
}
