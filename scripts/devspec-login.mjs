#!/usr/bin/env node
/**
 * Sign DevSpec's background features for Cursor (remote control, commit tracking) in
 * or out, through the browser. Nothing is pasted except, on a machine the browser
 * cannot reach, the one-time code DevSpec's page shows.
 *
 *   node scripts/devspec-login.mjs             sign in through your browser
 *   node scripts/devspec-login.mjs --code      sign in on a machine your browser cannot reach
 *   node scripts/devspec-login.mjs --paste "<code>"   finish a --code sign-in
 *   node scripts/devspec-login.mjs --status    show the server and who it is signed in as
 *   node scripts/devspec-login.mjs --sign-out  sign out of this server only
 *
 * The server is the one the plugin uses (production, or DEVSPEC_API_URL /
 * DEVSPEC_MCP_URL when set); `--server <mcp url>` names one explicitly. /devspec-remote
 * starts the same sign-in by itself the first time it needs one.
 *
 * Also run by the plugin itself, detached: `--background` (the browser approval's
 * listener) and `--renew` (one renewal under the login file's lock).
 */

import { loginCommandMain } from '../hooks/scripts/sign-in-flow.mjs'

loginCommandMain().then(
  (code) => { process.exitCode = code },
  (err) => {
    process.stderr.write(`devspec-login: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  },
)
