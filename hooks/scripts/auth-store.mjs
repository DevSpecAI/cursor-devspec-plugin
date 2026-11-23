/**
 * The background features' login file, item 95a67ee4.
 *
 * `~/.devspec/cursor/auth.json` (0600, directory 0700) holds one browser sign-in per
 * DevSpec server, keyed by the server's MCP address (origin + path), so a staging
 * login and a production login sit side by side and switching servers never needs a
 * fresh login (decision 7f6b2262). Only this plugin reads or writes it: sign-in is
 * once per tool (decision 912b3b3e), and no other tool's file is ever read for a
 * token, Cursor's own ~/.cursor/mcp.json included.
 *
 * Renewal: Clerk rotates the renewal key on every use and ends the whole grant if one
 * is used twice, so every renewal holds an exclusive lock on the file across
 * processes (the poller, the hooks and helpers all run at once) and re-reads the file
 * after taking it: another process may already have renewed. A token is renewed once
 * it is past half its life, so a token handed out still has about half its life left.
 *
 * Hooks resolve credentials synchronously. They never renew in their own process: a
 * hook can be killed at its timeout, and a renewal killed after Clerk rotated the key
 * but before the file was written would lose the only live key. They start a
 * detached renewal (scripts/devspec-login.mjs --renew) that outlives them and wait a
 * moment for it.
 *
 * The background sign-in markers live here too, so parallel callers start ONE browser
 * approval per server, never one each.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOGIN_SCRIPT, normalizeResource } from './devspec-server.mjs'
import { SIGN_IN_WAIT_MS, SignInEndedError, refreshTokens } from './sign-in.mjs'

const STORE_VERSION = 1

/**
 * A lock older than this is abandoned. A holder only renews (one network round trip,
 * bounded by SIGN_IN_REQUEST_TIMEOUT_MS) or writes the file, so a live holder always
 * finishes well inside it.
 */
const LOCK_STALE_MS = 60_000
const LOCK_RETRY_MS = 50

/** How long a hook waits for a detached renewal of a token that still works. */
export const DUE_RENEW_WAIT_MS = 3_000
/** How long it waits when the token has already stopped working (a machine that slept). */
export const EXPIRED_RENEW_WAIT_MS = 8_000
/** After a renewal failed for a passing reason, callers use the token they have for this long before trying again. */
export const RENEW_RETRY_AFTER_MS = 5 * 60_000
const RENEW_POLL_MS = 100

/** A claimed background sign-in whose helper never said it started is abandoned after this. */
const SIGN_IN_START_GRACE_MS = 20_000

export function authDir({ home } = {}) {
  return path.join(home || os.homedir(), '.devspec', 'cursor')
}

export function authFilePath(opts = {}) {
  return path.join(authDir(opts), 'auth.json')
}

function lockPath(opts) {
  return `${authFilePath(opts)}.lock`
}

function serverKey(mcpUrl) {
  return normalizeResource(mcpUrl)
}

function serverHash(mcpUrl) {
  return createHash('sha256').update(serverKey(mcpUrl)).digest('hex').slice(0, 16)
}

/** sha256 hex: the same fingerprint a pasted token always had. */
export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function ensureDir(opts) {
  const dir = authDir(opts)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* best effort; the files themselves are 0600 */
  }
  return dir
}

/** Write aside and rename, so a reader never sees half a file. */
function writePrivateJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(temp, 0o600)
  } catch {
    /* mode was set at creation */
  }
  fs.renameSync(temp, file)
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isLogin(value) {
  return !!value && typeof value === 'object' &&
    ['accessToken', 'refreshToken', 'issuedAt', 'expiresAt', 'issuer', 'tokenEndpoint', 'clientId', 'resource', 'loginId']
      .every((key) => typeof value[key] === 'string' && value[key])
}

/** The whole store. A missing or unreadable file reads as signed out everywhere. */
export function readStoreSync(opts = {}) {
  const parsed = readJsonFile(authFilePath(opts))
  const logins = {}
  if (parsed?.version === STORE_VERSION && parsed.logins && typeof parsed.logins === 'object') {
    for (const [key, value] of Object.entries(parsed.logins)) if (isLogin(value)) logins[key] = value
  }
  return { version: STORE_VERSION, logins }
}

function writeStoreSync(store, opts = {}) {
  ensureDir(opts)
  writePrivateJson(authFilePath(opts), store)
}

/**
 * Renew once an access token is past half its life, so any token handed out still has
 * at least half its life left: long-running work never holds one about to stop working.
 */
export function needsRenewal(login, now = Date.now()) {
  const issued = Date.parse(login.issuedAt)
  const expires = Date.parse(login.expiresAt)
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return true
  return now >= issued + (expires - issued) / 2
}

/** The modification time of a lock whose holder is gone or too old; null while held. */
function staleLockStamp(file) {
  try {
    const info = fs.statSync(file)
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return info.mtimeMs
    const holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10)
    if (!Number.isInteger(holder) || holder <= 0) return null
    return processAlive(holder) ? null : info.mtimeMs
  } catch {
    return null
  }
}

/** Whether some live process holds the login file's lock right now. */
export function storeLockHeld(opts = {}) {
  return fs.existsSync(lockPath(opts)) && staleLockStamp(lockPath(opts)) === null
}

/** Run `work` holding the store's exclusive lock across processes. */
export async function withStoreLock(work, opts = {}) {
  ensureDir(opts)
  const file = lockPath(opts)
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const stale = staleLockStamp(file)
      if (stale !== null) {
        // Clear it only if it is still the lock judged stale, not one a waiter beside
        // us has just taken.
        let now = null
        try { now = fs.statSync(file) } catch { /* gone already */ }
        if (now?.mtimeMs === stale) fs.rmSync(file, { force: true })
        continue
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  try {
    return await work()
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** What the store holds for one server: none, active, or ended (DevSpec refused to renew it). */
export function loginState(mcpUrl, opts = {}) {
  const login = readStoreSync(opts).logins[serverKey(mcpUrl)]
  if (!login) return { kind: 'none' }
  return login.endedAt ? { kind: 'ended', login } : { kind: 'active', login }
}

/**
 * The stable identity of a browser login: the same across its daily renewals, so
 * anything keyed by "who is this" survives the token changing. Never a secret.
 */
export function loginPrincipal(login) {
  return sha256(`devspec-cursor-login\0${login.issuer}\0${login.clientId}\0${login.loginId}`)
}

/**
 * The stable identity of a resolved credential (64 hex characters). A token from the
 * environment is fingerprinted by its value, exactly as before; a browser login by
 * its server, sign-in app and login id.
 */
export function principalOf(auth) {
  return auth?.principal ?? sha256(String(auth?.token ?? ''))
}

/** Save a new sign-in under the server it was approved for, replacing only that server's. */
export async function saveLogin({ mcpUrl, tokens, issuer, tokenEndpoint, revocationEndpoint, clientId, resource, signedInAs }, opts = {}) {
  if (serverKey(resource) !== serverKey(mcpUrl)) {
    throw new Error('A sign-in can only be saved for the server it was approved for.')
  }
  const login = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    issuedAt: new Date(tokens.issuedAt).toISOString(),
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    issuer,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    clientId,
    resource,
    loginId: randomUUID(),
    ...(signedInAs ? { signedInAs } : {}),
    savedAt: new Date().toISOString(),
  }
  await withStoreLock(async () => {
    const store = readStoreSync(opts)
    store.logins[serverKey(mcpUrl)] = login
    writeStoreSync(store, opts)
  }, opts)
  return login
}

/** Remove the sign-in for one server only. Returns what was removed, if anything. */
export async function removeLogin(mcpUrl, opts = {}) {
  return withStoreLock(async () => {
    const store = readStoreSync(opts)
    const key = serverKey(mcpUrl)
    const login = store.logins[key] ?? null
    if (login) {
      delete store.logins[key]
      writeStoreSync(store, opts)
    }
    return login
  }, opts)
}

/**
 * Renew one server's login if it is due, holding the lock and re-reading first.
 * `invalid_grant` ends the login (the person must sign in again); any other failure
 * keeps it, records when it failed, and leaves the current token in use.
 */
export async function renewLogin(mcpUrl, { refresh = refreshTokens, ...opts } = {}) {
  const key = serverKey(mcpUrl)
  return withStoreLock(async () => {
    // Another process may have renewed while we waited for the lock.
    const store = readStoreSync(opts)
    const login = store.logins[key]
    if (!login) return { status: 'none' }
    if (login.endedAt) return { status: 'ended', login }
    if (!needsRenewal(login)) return { status: 'fresh', login }
    try {
      const tokens = await refresh({
        tokenEndpoint: login.tokenEndpoint,
        clientId: login.clientId,
        refreshToken: login.refreshToken,
        resource: login.resource,
      })
      login.accessToken = tokens.accessToken
      login.refreshToken = tokens.refreshToken
      login.issuedAt = new Date(tokens.issuedAt).toISOString()
      login.expiresAt = new Date(tokens.expiresAt).toISOString()
      delete login.renewFailedAt
      writeStoreSync(store, opts)
      return { status: 'renewed', login }
    } catch (err) {
      if (err instanceof SignInEndedError) {
        login.endedAt = new Date().toISOString()
        writeStoreSync(store, opts)
        return { status: 'ended', login }
      }
      login.renewFailedAt = new Date().toISOString()
      writeStoreSync(store, opts)
      return { status: 'failed', login, error: err instanceof Error ? err.message : String(err) }
    }
  }, opts)
}

/**
 * DevSpec refused this login outright (the person disconnected Cursor on the Agent
 * setup page): stop using it, so the next sign-in starts afresh. Only the login that
 * was refused is ended, never a newer one saved since.
 */
export async function markLoginEnded(mcpUrl, principal, opts = {}) {
  return withStoreLock(async () => {
    const store = readStoreSync(opts)
    const login = store.logins[serverKey(mcpUrl)]
    if (!login || login.endedAt || loginPrincipal(login) !== principal) return false
    login.endedAt = new Date().toISOString()
    writeStoreSync(store, opts)
    return true
  }, opts)
}

/** Start `scripts/devspec-login.mjs --renew` in its own process, unless a renewal is already running. */
export function startDetachedRenewal(mcpUrl, opts = {}) {
  if (storeLockHeld(opts)) return false
  const home = opts.home || os.homedir()
  try {
    spawn(process.execPath, [LOGIN_SCRIPT, '--renew', '--server', mcpUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }).on('error', () => {}).unref()
    return true
  } catch {
    return false
  }
}

function recentlyFailed(login, now) {
  const failed = Date.parse(login.renewFailedAt ?? '')
  return Number.isFinite(failed) && now - failed < RENEW_RETRY_AFTER_MS
}

/**
 * One server's login for a synchronous caller (hooks, connect helpers, the poller's
 * lap): renewed first when it is past half its life. Returns the login state, plus
 * `expired` when the token has stopped working and could not be renewed just now.
 */
export function currentLoginSync(mcpUrl, { renew = startDetachedRenewal, now = Date.now, ...opts } = {}) {
  let state = loginState(mcpUrl, opts)
  if (state.kind !== 'active' || !needsRenewal(state.login, now())) return state
  const isExpired = (login) => Date.parse(login.expiresAt) <= now()
  if (!recentlyFailed(state.login, now())) {
    const started = now()
    renew(mcpUrl, opts)
    const deadline = started + (isExpired(state.login) ? EXPIRED_RENEW_WAIT_MS : DUE_RENEW_WAIT_MS)
    while (now() < deadline) {
      sleepSync(RENEW_POLL_MS)
      state = loginState(mcpUrl, opts)
      if (state.kind !== 'active' || !needsRenewal(state.login, now())) return state
      // The renewal finished without renewing (offline, say): stop waiting for it.
      if (recentlyFailed(state.login, now()) && Date.parse(state.login.renewFailedAt) >= started - 1_000) break
    }
  }
  if (state.kind === 'active' && isExpired(state.login)) return { kind: 'expired', login: state.login }
  return state
}

// --- One browser approval per server -----------------------------------------------

function pendingPath(mcpUrl, opts) {
  return path.join(authDir(opts), `sign-in-${serverHash(mcpUrl)}.pending.json`)
}

function resultPath(mcpUrl, opts) {
  return path.join(authDir(opts), `sign-in-${serverHash(mcpUrl)}.result.json`)
}

function codePath(mcpUrl, opts) {
  return path.join(authDir(opts), `sign-in-${serverHash(mcpUrl)}.code.json`)
}

/** The running background sign-in for this server, or null when none is running. */
export function livePendingSignIn(mcpUrl, { now = Date.now, ...opts } = {}) {
  const file = pendingPath(mcpUrl, opts)
  const marker = readJsonFile(file)
  let stat = null
  try { stat = fs.statSync(file) } catch { return null }
  const startedAt = Number(marker?.startedAt) || stat.mtimeMs
  const age = now() - startedAt
  if (Number.isInteger(marker?.pid)) {
    return processAlive(marker.pid) && age < SIGN_IN_WAIT_MS + 60_000 ? { ...marker, startedAt } : null
  }
  // Claimed, and its helper has not said it started yet.
  return age < SIGN_IN_START_GRACE_MS ? { ...marker, startedAt } : null
}

/** The outcome of the last background sign-in for this server, once it finished. */
export function lastSignInResult(mcpUrl, opts = {}) {
  return readJsonFile(resultPath(mcpUrl, opts))
}

function removeIfUnchanged(file, stamp) {
  try {
    if (fs.statSync(file).mtimeMs === stamp) fs.rmSync(file, { force: true })
  } catch {
    /* already gone */
  }
}

/** The background helper says which sign-in it is running (its pid and the link). */
export function recordPendingSignIn(mcpUrl, fields, opts = {}) {
  const file = pendingPath(mcpUrl, opts)
  const marker = readJsonFile(file) ?? { version: 1, server: serverKey(mcpUrl), startedAt: Date.now() }
  ensureDir(opts)
  writePrivateJson(file, { ...marker, ...fields })
}

/** The background helper is done: record how it went and free the server for the next sign-in. */
export function finishPendingSignIn(mcpUrl, result, opts = {}) {
  ensureDir(opts)
  writePrivateJson(resultPath(mcpUrl, opts), { version: 1, server: serverKey(mcpUrl), finishedAt: Date.now(), ...result })
  const marker = readJsonFile(pendingPath(mcpUrl, opts))
  if (!marker || marker.pid === process.pid || !processAlive(marker.pid)) fs.rmSync(pendingPath(mcpUrl, opts), { force: true })
}

function spawnBackgroundSignIn(mcpUrl, opts = {}) {
  const home = opts.home || os.homedir()
  spawn(process.execPath, [LOGIN_SCRIPT, '--background', '--server', mcpUrl], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...(opts.env ?? {}), HOME: home, USERPROFILE: home },
  }).on('error', () => {}).unref()
}

/**
 * Start the browser approval for this server, once. Parallel callers (two helpers,
 * several hooks) race on an exclusive marker file: one starts the approval and every
 * other caller joins it, so the person gets one browser tab. Never blocks for more
 * than `waitForUrlMs`, the time it takes the helper to print its link.
 *
 * Returns `{ status: 'started' | 'pending', url, startedAt }`, or
 * `{ status: 'failed', error }` when the helper could not start (say, a server that
 * does not offer browser sign-in yet).
 */
export function beginBackgroundSignIn(mcpUrl, { spawnChild = spawnBackgroundSignIn, waitForUrlMs = 5_000, now = Date.now, ...opts } = {}) {
  const live = livePendingSignIn(mcpUrl, { now, ...opts })
  if (live) return { status: 'pending', url: live.url ?? null, startedAt: live.startedAt }
  ensureDir(opts)
  const file = pendingPath(mcpUrl, opts)
  const startedAt = now()
  let claimed = false
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeSync(fd, JSON.stringify({ version: 1, server: serverKey(mcpUrl), startedAt, pid: null, url: null }))
      } finally {
        fs.closeSync(fd)
      }
      claimed = true
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const again = livePendingSignIn(mcpUrl, { now, ...opts })
      if (again) return { status: 'pending', url: again.url ?? null, startedAt: again.startedAt }
      let stamp = null
      try { stamp = fs.statSync(file).mtimeMs } catch { /* gone */ }
      if (stamp !== null) removeIfUnchanged(file, stamp)
    }
  }
  if (!claimed) return { status: 'pending', url: null, startedAt }
  spawnChild(mcpUrl, opts)
  const deadline = now() + waitForUrlMs
  while (now() < deadline) {
    sleepSync(100)
    const marker = readJsonFile(file)
    if (marker?.url) return { status: 'started', url: marker.url, startedAt }
    if (!fs.existsSync(file)) {
      const result = lastSignInResult(mcpUrl, opts)
      if (result && result.finishedAt >= startedAt) {
        return result.outcome === 'signed_in'
          ? { status: 'signed_in', startedAt }
          : { status: 'failed', error: result.error || 'The sign-in could not start.', startedAt }
      }
      break
    }
  }
  return { status: 'started', url: null, startedAt }
}

/**
 * Wait for a background sign-in to land in the login file. This reads the local file
 * only: the approval itself comes back through the person's browser to the helper's
 * own listener, never by asking DevSpec's server whether it happened.
 */
export async function waitForBackgroundSignIn(mcpUrl, { since, timeoutMs, pollMs = 500, now = Date.now, ...opts } = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    const state = loginState(mcpUrl, opts)
    if (state.kind === 'active' && Date.parse(state.login.savedAt) >= since - 1_000) return { status: 'signed_in', login: state.login }
    const result = lastSignInResult(mcpUrl, opts)
    if (result && result.finishedAt >= since && result.outcome !== 'signed_in') {
      return { status: 'failed', error: result.error || 'The sign-in did not finish.' }
    }
    if (now() >= deadline) {
      const live = livePendingSignIn(mcpUrl, { now, ...opts })
      return { status: 'pending', url: live?.url ?? null }
    }
    await sleep(pollMs)
  }
}

// --- Copy-a-code sign-ins waiting for the person's paste ---------------------------

/** Keep a copy-a-code sign-in's verifier on this machine until the person pastes the code. */
export function saveCodeSignIn(mcpUrl, pending, opts = {}) {
  ensureDir(opts)
  writePrivateJson(codePath(mcpUrl, opts), { version: 1, server: serverKey(mcpUrl), mcpUrl, startedAt: Date.now(), ...pending })
}

/** The copy-a-code sign-in waiting for this server, if it is still young enough to finish. */
export function readCodeSignIn(mcpUrl, { now = Date.now, ...opts } = {}) {
  const saved = readJsonFile(codePath(mcpUrl, opts))
  if (!saved || saved.server !== serverKey(mcpUrl) || !(now() - Number(saved.startedAt) < SIGN_IN_WAIT_MS)) return null
  return saved
}

export function clearCodeSignIn(mcpUrl, opts = {}) {
  fs.rmSync(codePath(mcpUrl, opts), { force: true })
}
