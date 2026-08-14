#!/usr/bin/env node
/**
 * Start a fresh interactive Pi session for a signed DevSpec handoff.
 *
 * Runtime overrides are deliberately optional. Omitting --model and --thinking
 * lets Pi use the user's own current/default configuration.
 */
import fs from 'node:fs/promises'
import { spawnAgentSync } from './launch-cli-session.mjs'

export const PI_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

export function parsePiLaunchArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--folder' && argv[i + 1]) out.folder = argv[++i]
    else if (arg === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i]
    else if (arg === '--pi' && argv[i + 1]) out.pi = argv[++i]
    else if (arg === '--model' && argv[i + 1]) out.model = argv[++i]
    else if (arg === '--thinking' && argv[i + 1]) out.thinking = argv[++i]
  }
  return out
}

export function buildPiLaunchArgs(promptBody, options = {}) {
  const args = []
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  if (model) args.push('--model', model)

  const thinking = typeof options.thinking === 'string' ? options.thinking.trim() : ''
  if (PI_THINKING_LEVELS.includes(thinking)) args.push('--thinking', thinking)

  const prompt = String(promptBody ?? '').trim()
  if (prompt) args.push(prompt)
  return args
}

async function main() {
  const args = parsePiLaunchArgs(process.argv.slice(2))
  if (!args.folder || !args.promptFile) {
    console.error(
      'Usage: launch-pi-session.mjs --folder <path> --prompt-file <path> [--pi <path>] [--model <provider/id>] [--thinking <level>]',
    )
    process.exitCode = 1
    return
  }

  let promptBody
  try {
    promptBody = await fs.readFile(args.promptFile, 'utf8')
  } catch (error) {
    console.error(`[devspec-pi] could not read prompt file: ${error}`)
    process.exitCode = 1
    return
  }

  const piBin = args.pi || 'pi'
  const piArgs = buildPiLaunchArgs(promptBody, {
    model: args.model,
    thinking: args.thinking,
  })
  const result = spawnAgentSync(piBin, piArgs, {
    cwd: args.folder,
    stdio: 'inherit',
    encoding: 'utf8',
  })
  if (result.error) {
    console.error(`[devspec-pi] failed to start Pi: ${result.error.message}`)
    process.exitCode = 1
    return
  }
  process.exitCode = result.status ?? 0
}

if (process.argv[1]?.endsWith('launch-pi-session.mjs')) {
  void main()
}
