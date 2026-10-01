/**
 * Links to DevSpec pages a person opens, built from the host this plugin uses.
 *
 * DevSpec splits its hosts by role. The machine API (MCP at /api/mcp) answers
 * on https://api.devspec.ai (staging https://api.devspecstaging.com); the pages
 * a person opens live on https://app.devspec.ai (staging
 * https://app.devspecstaging.com). A link printed to a person therefore has to
 * name the app host of the environment the plugin is actually talking to: a
 * staging machine sent to production lands on an account that is not theirs.
 *
 * App base order: explicit DEVSPEC_APP_URL → the settled app host for the
 * API/MCP URL in use → the same origin for a loopback dev server (one Next.js
 * server serves both there) → production. Only the settled host pairs are
 * rewritten; a hostname is never invented from an arbitrary API URL.
 */

export const DEFAULT_APP_URL = 'https://app.devspec.ai'

/** Personal settings → Agents: where a person creates or reveals their key. */
export const AGENTS_PAGE_PATH = '/settings/agents'

const APP_BASE_FOR_HOST = new Map([
  ['api.devspec.ai', 'https://app.devspec.ai'],
  ['app.devspec.ai', 'https://app.devspec.ai'],
  ['api.devspecstaging.com', 'https://app.devspecstaging.com'],
  ['app.devspecstaging.com', 'https://app.devspecstaging.com'],
])

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function trimBase(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
}

/**
 * The app origin for human pages, given the API or MCP URL the plugin uses.
 * @param {string | null | undefined} apiUrl
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 */
export function resolveAppBaseUrl(apiUrl, opts = {}) {
  const env = opts.env ?? process.env
  const explicit = trimBase(env?.DEVSPEC_APP_URL)
  if (explicit) return explicit
  let url
  try {
    url = new URL(String(apiUrl ?? ''))
  } catch {
    return DEFAULT_APP_URL
  }
  const settled = APP_BASE_FOR_HOST.get(url.hostname)
  if (settled) return settled
  if (LOOPBACK_HOSTS.has(url.hostname)) return url.origin
  return DEFAULT_APP_URL
}

/** The full Agents page URL for the environment behind `apiUrl`. */
export function agentsPageUrl(apiUrl, opts = {}) {
  return `${resolveAppBaseUrl(apiUrl, opts)}${AGENTS_PAGE_PATH}`
}

/**
 * The Agents page link(s) for every environment in play, joined for a
 * sentence. Two keys on two environments are revealed on two different pages,
 * so each distinct environment gets its own link, in the order given.
 * @param {Array<string | null | undefined>} apiUrls
 */
export function agentsPageLinks(apiUrls, opts = {}) {
  const urls = [...new Set((apiUrls?.length ? apiUrls : [null]).map((u) => agentsPageUrl(u, opts)))]
  return urls.join(' or ')
}
