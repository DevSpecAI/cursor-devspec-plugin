#!/usr/bin/env node
/**
 * The DevSpec credential the plugin's background features use: remote control (the
 * poller, the wait, turn mirroring), commit tracking and the connect helpers.
 *
 * Cursor's own connection (the agent's DevSpec tools) signs in by itself, with
 * Cursor's built-in sign-in for the plugin's mcp.json entry. Those hook and helper
 * processes cannot use Cursor's sign-in, so they hold their own browser sign-in
 * through the same Cursor app (item 95a67ee4):
 *
 * 1. DEVSPEC_MCP_TOKEN — for a machine with no browser (CI, a cloud worker), paired
 *    with DEVSPEC_MCP_URL. It wins outright, and whoever sets it interactively is
 *    told so (envTokenNotice).
 * 2. The plugin's own browser sign-in for the configured server, from
 *    ~/.devspec/cursor/auth.json (auth-store.mjs), renewed before it expires.
 *
 * Nothing else. No other tool's file is read for a token any more: not Cursor's
 * ~/.cursor/mcp.json, not a project .cursor/mcp.json or .mcp.json, and not another
 * DevSpec plugin's login. The server is the one the plugin's mcp.json names, filled
 * from the environment exactly as Cursor fills it (devspec-server.mjs).
 *
 * A connection keeps the identity it connected with. Its state records which login
 * (`principal`) and never a browser login's token, which changes daily; every use
 * takes that login's current token (connectionCredential), and refuses rather than
 * switch to a different login. A token from the environment is stored and
 * fingerprinted exactly as before.
 *
 * CLI: prints `{ ok, token?, mcp_url, source, code?, error? }` as JSON for piping.
 */

import os from 'node:os'
import { agentsPageUrl } from './app-pages.mjs'
import { currentLoginSync, loginPrincipal, loginState, markLoginEnded, sha256 } from './auth-store.mjs'
import {
  DEFAULT_MCP_URL as BUNDLED_DEFAULT_MCP_URL,
  configuredMcpUrl,
  loginCommand,
  mcpUrlForServer,
  normalizeResource,
  serverLabel,
} from './devspec-server.mjs'

export const DEFAULT_MCP_URL = BUNDLED_DEFAULT_MCP_URL

/** The one environment variable for a machine with no browser. */
export const TOKEN_ENV_VAR = 'DEVSPEC_MCP_TOKEN'

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The token set in the environment for a machine with no browser, if any. */
export function hostTokenFromEnv(env = process.env) {
  return trimmed(env?.[TOKEN_ENV_VAR])
}

function envOf(opts) {
  return Object.hasOwn(opts, 'env') ? (opts.env || {}) : process.env
}

/** Where the login file lives for this call; an injected env with no home has none. */
function storeOpts(opts) {
  const env = envOf(opts)
  const home = opts.home || env.HOME || env.USERPROFILE || (Object.hasOwn(opts, 'env') ? null : os.homedir())
  return home ? { home, ...(opts.renew ? { renew: opts.renew } : {}) } : null
}

/** The command that signs the background features in to this server, for messages. */
export function loginCommandFor(mcpUrl) {
  let server = ''
  try {
    if (normalizeResource(mcpUrl) !== normalizeResource(DEFAULT_MCP_URL)) {
      const named = new URL(mcpUrl)
      server = normalizeResource(mcpUrlForServer(named.origin, {})) === normalizeResource(mcpUrl)
        ? `--server ${named.origin}`
        : `--server "${mcpUrl}"`
    }
  } catch {
    /* an unparseable address gets the plain command */
  }
  return loginCommand(server)
}

/** How to sign in again, in plain words. */
export function signInAgainHint(mcpUrl = DEFAULT_MCP_URL) {
  return 'To sign in again, run /devspec-remote in cursor-agent (it opens DevSpec\'s approval page in your browser), ' +
    `or run ${loginCommandFor(mcpUrl)} in a terminal.`
}

export function notSignedInMessage(mcpUrl = DEFAULT_MCP_URL) {
  return `Cursor's DevSpec background features (remote control and commit tracking) are not signed in to DevSpec (${serverLabel(mcpUrl)}). ` +
    'Run /devspec-remote in cursor-agent to approve them in your browser, ' +
    `or run ${loginCommandFor(mcpUrl)} in a terminal.`
}

export function loginEndedMessage(mcpUrl = DEFAULT_MCP_URL) {
  return `Your DevSpec sign-in for Cursor's background features has ended, for example because Cursor was disconnected on DevSpec's Agent setup page (${agentsPageUrl(mcpUrl)}). ` +
    signInAgainHint(mcpUrl)
}

export function renewalUnavailableMessage(mcpUrl = DEFAULT_MCP_URL) {
  return `Cursor's DevSpec sign-in (${serverLabel(mcpUrl)}) could not be renewed just now; is this computer offline? ` +
    `It tries again on the next use. If this keeps happening, sign in again: run ${loginCommandFor(mcpUrl)} in a terminal.`
}

export function signedInAgainMessage() {
  return 'You signed in to DevSpec again since this conversation connected, and its connection still belongs to the earlier sign-in. ' +
    'Run /devspec-remote to connect it with the new sign-in.'
}

/** Plain words for a token in the environment, which always wins over a browser sign-in. */
export function envTokenNotice(platform = process.platform) {
  const where = platform === 'win32'
    ? 'System Properties → Environment Variables, and any terminal profile that sets it'
    : `your shell profile (for example ~/.zshrc or ~/.bashrc) and run \`unset ${TOKEN_ENV_VAR}\` in this terminal`
  return `${TOKEN_ENV_VAR} is set in this environment, so the DevSpec plugin's background features use that token and ignore your browser sign-in. ` +
    `To use your browser sign-in, remove ${TOKEN_ENV_VAR} from ${where}, then restart cursor-agent.`
}

/**
 * The credential for one call, resolved now.
 *
 * `{ ok: true, token, mcp_url, source: 'env' | 'login', principal }`, or
 * `{ ok: false, code, mcp_url, error }` where code is `sign_in_required` (never signed
 * in to this server), `signed_out` (the login ended) or `sign_in_unavailable` (it has
 * expired and could not be renewed just now). `error` is the sentence to show.
 */
export function resolveDevspecMcpAuth(_cwd = process.cwd(), opts = {}) {
  const env = envOf(opts)
  const mcpUrl = configuredMcpUrl(env)
  const envToken = trimmed(opts.hostToken) || hostTokenFromEnv(env)
  if (envToken) {
    return { ok: true, token: envToken, mcp_url: mcpUrl, source: 'env', principal: sha256(envToken) }
  }
  const store = storeOpts(opts)
  const state = store ? currentLoginSync(mcpUrl, store) : { kind: 'none' }
  if (state.kind === 'active') {
    return {
      ok: true,
      token: state.login.accessToken,
      mcp_url: mcpUrl,
      source: 'login',
      principal: loginPrincipal(state.login),
      ...(state.login.signedInAs ? { signed_in_as: state.login.signedInAs } : {}),
    }
  }
  if (state.kind === 'ended') return { ok: false, code: 'signed_out', mcp_url: mcpUrl, source: 'login', error: loginEndedMessage(mcpUrl) }
  if (state.kind === 'expired') return { ok: false, code: 'sign_in_unavailable', mcp_url: mcpUrl, source: 'login', error: renewalUnavailableMessage(mcpUrl) }
  return { ok: false, code: 'sign_in_required', mcp_url: mcpUrl, error: notSignedInMessage(mcpUrl) }
}

/**
 * Whether a browser login for the configured server sits unused because
 * DEVSPEC_MCP_TOKEN is set: then the person is told the token takes precedence.
 */
export function envTokenShadowsLogin(opts = {}) {
  const env = envOf(opts)
  if (!hostTokenFromEnv(env)) return false
  const store = storeOpts(opts)
  return !!store && loginState(configuredMcpUrl(env), store).kind !== 'none'
}

/**
 * The current credential for a connection, from its state file. A connection made
 * with a browser login takes that login's current token on every use (it changes
 * daily) and refuses rather than switch to a different login; one made with a token
 * from the environment keeps using that token, exactly as before.
 */
export function connectionCredential(state, opts = {}) {
  if (!state || typeof state !== 'object') return { ok: false, code: 'no_state', error: 'No DevSpec connection state.' }
  const mcpUrl = state.mcp_url || configuredMcpUrl(envOf(opts))
  if (state.auth_source === 'login') {
    const store = storeOpts(opts)
    const current = store ? currentLoginSync(mcpUrl, store) : { kind: 'none' }
    if (current.kind === 'active') {
      if (loginPrincipal(current.login) !== state.principal) {
        return { ok: false, code: 'signed_in_again', mcp_url: mcpUrl, error: signedInAgainMessage() }
      }
      return { ok: true, token: current.login.accessToken, mcp_url: mcpUrl, source: 'login', principal: state.principal }
    }
    if (current.kind === 'expired') return { ok: false, code: 'sign_in_unavailable', mcp_url: mcpUrl, error: renewalUnavailableMessage(mcpUrl) }
    if (current.kind === 'ended') return { ok: false, code: 'signed_out', mcp_url: mcpUrl, error: loginEndedMessage(mcpUrl) }
    return { ok: false, code: 'signed_out', mcp_url: mcpUrl, error: `Cursor's background features were signed out of DevSpec (${serverLabel(mcpUrl)}). ${signInAgainHint(mcpUrl)}` }
  }
  const token = trimmed(state.token) || trimmed(state.mcp_token)
  if (token) return { ok: true, token, mcp_url: mcpUrl, source: 'env', principal: sha256(token) }
  // A state written without a credential: resolve as at connect time, for its own server only.
  const auth = resolveDevspecMcpAuth(state.cwd || process.cwd(), opts)
  if (auth.ok && state.mcp_url && normalizeResource(state.mcp_url) !== normalizeResource(auth.mcp_url)) {
    return { ok: false, code: 'server_changed', mcp_url: state.mcp_url, error: `This connection is on ${serverLabel(state.mcp_url)}, but the plugin now uses ${serverLabel(auth.mcp_url)}. Run /devspec-remote to reconnect.` }
  }
  return auth.ok ? { ...auth, mcp_url: state.mcp_url || auth.mcp_url } : auth
}

/** The connection's current token, or null. */
export function connectionToken(state, opts = {}) {
  const credential = connectionCredential(state, opts)
  return credential.ok ? credential.token : null
}

/**
 * Who a connection acts as, for anything that binds work to it (commit observation
 * markers, reusing a running poller). A token from the environment keeps the exact
 * binding it always had (the token itself); a browser login is its stable principal,
 * so the daily token change does not look like a different person.
 */
export function credentialIdentity(state) {
  if (!state || typeof state !== 'object') return null
  if (state.auth_source === 'login') return typeof state.principal === 'string' && state.principal ? `login:${state.principal}` : null
  return trimmed(state.token) || trimmed(state.mcp_token)
}

/** The fields a connection's state file records about its credential. */
export function credentialStateFields(auth) {
  // `mcp_token` is an older name for `token`; neither survives a rewrite unless it is
  // the token this connection now uses.
  if (!auth?.ok) return { token: undefined, mcp_token: undefined, auth_source: auth?.code || auth?.source || null, principal: undefined }
  if (auth.source === 'login') return { token: undefined, mcp_token: undefined, auth_source: 'login', principal: auth.principal }
  return { token: auth.token, mcp_token: undefined, auth_source: auth.source || 'env', principal: undefined }
}

function serverSentence(err) {
  try {
    const text = typeof err?.body === 'string' ? err.body : ''
    const start = text.indexOf('{')
    const body = start >= 0 ? JSON.parse(text.slice(start)) : null
    return typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : null
  } catch {
    return null
  }
}

/**
 * DevSpec refused the credential itself (not a passing outage): the plain sentence to
 * show, or null for any other failure. `signed_out` is DevSpec saying the person
 * disconnected this tool; its own sentence is shown, followed by how to sign in again.
 */
export function credentialRefusal(err, { mcpUrl = DEFAULT_MCP_URL, source = 'login' } = {}) {
  if (!err || err.status !== 401 || err.retryable === true) return null
  if (err.serverCode === 'signed_out') {
    const said = serverSentence(err) ||
      'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.'
    return { code: 'signed_out', message: `${said} ${signInAgainHint(mcpUrl)}` }
  }
  if (err.serverCode === 'invalid_api_token') {
    return {
      code: 'invalid_api_token',
      message: source === 'env'
        ? `DevSpec rejected the token in ${TOKEN_ENV_VAR} (invalid or revoked). Set a current token, or remove ${TOKEN_ENV_VAR} to use your browser sign-in.`
        : `DevSpec no longer accepts Cursor's sign-in. ${signInAgainHint(mcpUrl)}`,
    }
  }
  return null
}

/**
 * A DevSpec call failed: when DevSpec refused the credential itself, say so plainly
 * and, for a browser login, stop using that login so the next sign-in starts afresh.
 * Returns `{ code, message }`, or null for any other failure.
 */
export async function handleCredentialRefusal(err, auth, opts = {}) {
  const refusal = credentialRefusal(err, { mcpUrl: auth?.mcp_url || DEFAULT_MCP_URL, source: auth?.source || 'login' })
  if (!refusal) return null
  const store = storeOpts(opts)
  if (auth?.source === 'login' && auth.principal && store) {
    await markLoginEnded(auth.mcp_url, auth.principal, store).catch(() => false)
  }
  return refusal
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  const result = resolveDevspecMcpAuth(process.cwd(), { env: process.env })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
