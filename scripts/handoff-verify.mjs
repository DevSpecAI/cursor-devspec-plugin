/**
 * Verify Ed25519-signed DevSpec cursor handoff tokens.
 * Public key is bundled; private key lives only on DevSpec servers (CURSOR_HANDOFF_PRIVATE_KEY_PEM).
 */
import { createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let cachedPublicKey

function loadPublicKey() {
  if (cachedPublicKey) return cachedPublicKey
  const pemPath = path.join(__dirname, 'handoff-public-key.pem')
  const pem = fs.readFileSync(pemPath, 'utf8')
  cachedPublicKey = createPublicKey(pem)
  return cachedPublicKey
}

/**
 * @param {string} token  base64url(payload).base64url(signature)
 * @returns {{ ok: true, data: { repo: string, prompt?: string, title?: string, surface?: 'ide' | 'cli', tool?: 'cursor' | 'opencode' | 'pi', model?: string, thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', exp: number } } | { ok: false, error: string }}
 */
export function verifyHandoffToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'missing_token' }

  const dot = token.indexOf('.')
  if (dot <= 0) return { ok: false, error: 'malformed_token' }

  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  let payloadBuf
  let sigBuf
  try {
    payloadBuf = Buffer.from(payloadB64, 'base64url')
    sigBuf = Buffer.from(sigB64, 'base64url')
  } catch {
    return { ok: false, error: 'malformed_token' }
  }

  const key = loadPublicKey()
  const valid = verify(null, payloadBuf, key, sigBuf)
  if (!valid) return { ok: false, error: 'bad_signature' }

  let data
  try {
    data = JSON.parse(payloadBuf.toString('utf8'))
  } catch {
    return { ok: false, error: 'malformed_payload' }
  }

  if (!data || typeof data.repo !== 'string' || !data.repo.includes('/')) {
    return { ok: false, error: 'invalid_payload' }
  }

  const exp = Number(data.exp)
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'expired' }
  }

  /** @type {'ide' | 'cli' | undefined} */
  let surface
  if (data.surface === 'cli' || data.surface === 'ide') surface = data.surface

  /** @type {'cursor' | 'opencode' | 'pi' | undefined} */
  let tool
  if (data.tool === 'cursor' || data.tool === 'opencode' || data.tool === 'pi') tool = data.tool

  const model =
    typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined
  const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const thinking = thinkingLevels.has(data.thinking) ? data.thinking : undefined

  return {
    ok: true,
    data: {
      repo: data.repo,
      prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
      title: typeof data.title === 'string' ? data.title : undefined,
      surface,
      tool,
      model,
      thinking,
      exp,
    },
  }
}
