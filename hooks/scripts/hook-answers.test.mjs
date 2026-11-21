#!/usr/bin/env node
/**
 * Every plugin hook gives Cursor an answer and exits 0 (item 6ddde907).
 *
 * cursor-agent logs a hook that prints nothing as failed (`empty_stdout`), and one that
 * exits non-zero as failed (`exit_nonzero`). It runs a hook's command in the person's
 * own shell, and under zsh (macOS's default) a glob that matches nothing is an error:
 * the postToolUse hooks that look for pending work exited 1 on every tool call while
 * nothing was pending.
 *
 * The subjects come from hooks.json itself, so a hook added later is checked too. Each is
 * run the way Cursor runs it, in each shell a person may have, with a representative input
 * for its event: signed out of everything, connected and idle, and in the middle of a
 * remote-driven turn with work pending. Nothing here reaches a real DevSpec: the
 * connection points at a stand-in on this machine.
 *
 * Run: node --test hooks/scripts/hook-answers.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
const CONVERSATION = '0c0c0c0c-1111-4222-8333-444444444444'
const CONNECTION = '0d0d0d0d-1111-4222-8333-444444444444'
const SESSION = '0e0e0e0e-1111-4222-8333-444444444444'

const shellAvailable = (shell) => spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
const SHELLS = ['sh', 'bash', 'zsh'].filter(shellAvailable)

let server
let mcpUrl
const homes = []

before(async () => {
  // A DevSpec stand-in: every tool call is answered, a post is stored.
  server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, delivery: { status: 'stored' } }) }] } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  mcpUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
})

/** A home in one of three states: 'signed_out', 'connected' (idle), or 'mid_turn'. */
function homeIn(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cursor-hook-answers-${state}-`))
  homes.push(home)
  const cwd = path.join(home, 'work')
  fs.mkdirSync(cwd)
  if (state === 'signed_out') return { home, cwd }
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true, connection_id: CONNECTION, local_id: CONVERSATION, agent_name: 'Cursor', session_id: SESSION,
    mcp_url: mcpUrl, token: 'dvs_fixture', owner_pid: process.pid, cwd, current_command_turn_id: 'turn-1', turn_id: 'turn-1',
  }))
  if (state === 'mid_turn') {
    fs.writeFileSync(path.join(dir, `${CONNECTION}.turn`), JSON.stringify({ startedAt: Date.now() }))
    fs.writeFileSync(path.join(dir, `${CONNECTION}.turn-commands.json`), JSON.stringify({ version: 1, commands: [{ turn_id: 'turn-1', message_id: 'message-1' }] }))
    fs.mkdirSync(path.join(dir, `${CONNECTION}.steps`))
    fs.writeFileSync(path.join(dir, `${CONNECTION}.steps`, 'step-1.json'), '{}')
    for (const [folder, file] of [
      [['recall', 'cursor', 'pending'], 'pending.json'],
      [['notes', 'pending'], 'repo-link-pending.json'],
      [['notes', 'pending'], 'pin-pending.json'],
      [['cursor-git-stand-in', '0'.repeat(32)], 'pending'],
    ]) {
      fs.mkdirSync(path.join(home, '.devspec', ...folder), { recursive: true })
      fs.writeFileSync(path.join(home, '.devspec', ...folder, file), '{}')
    }
  }
  return { home, cwd }
}

/** Representative inputs for each of Cursor's hook events. */
function inputsFor(event, { home, cwd }) {
  const base = { conversation_id: CONVERSATION, generation_id: 'generation-1', hook_event_name: event, workspace_roots: [cwd], cursor_version: '2026.11.05', model: 'auto' }
  const transcript = path.join(home, 'transcript.jsonl')
  fs.writeFileSync(transcript, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })}\n`)
  const shell = { tool_name: 'Shell', tool_input: { command: 'ls' }, tool_use_id: 'tool-1' }
  const read = { tool_name: 'Read', tool_input: { path: 'README.md' }, tool_use_id: 'tool-2' }
  const mcp = { tool_name: 'get_tasks', tool_input: '{}', mcp_server_name: 'devspec', url: mcpUrl }
  const byEvent = {
    sessionStart: [{}],
    stop: [{ status: 'completed', loop_count: 0, transcript_path: transcript }],
    beforeSubmitPrompt: [{ prompt: 'please list the files', attachments: [] }],
    preToolUse: [shell, read, { tool_name: 'MCP:devspec__get_tasks', tool_input: {}, tool_use_id: 'tool-3' }],
    postToolUse: [
      { ...shell, tool_output: JSON.stringify({ exitCode: 0, output: 'README.md' }), duration: 12 },
      { ...read, tool_output: 'contents', duration: 3 },
    ],
    postToolUseFailure: [{ ...shell, error_message: 'exit status 1', failure_type: 'error' }],
    beforeShellExecution: [{ command: 'ls', cwd }],
    afterShellExecution: [{ command: 'ls', output: 'README.md', duration: 12 }],
    beforeMCPExecution: [mcp],
    afterMCPExecution: [{ ...mcp, result_json: JSON.stringify({ content: [{ type: 'text', text: '{"tasks":[]}' }] }), duration: 40 }],
    afterFileEdit: [{ file_path: path.join(cwd, 'README.md'), edits: [{ old_string: 'a', new_string: 'b' }] }],
    afterAgentThought: [{ text: 'Thinking it over.', duration_ms: 5 }],
    preCompact: [{ trigger: 'auto', context_usage_percent: 80 }],
  }
  assert.ok(byEvent[event], `no representative input for the ${event} event: add one here`)
  return byEvent[event].map((input) => ({ ...base, ...input }))
}

/** One hook command run the way Cursor runs it: in `shell`, the payload on stdin. */
function runHook(shell, command, input, { home, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-c', command], {
      cwd,
      env: { HOME: home, PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: ROOT, CURSOR_PLUGIN_ROOT: ROOT, CURSOR_PROJECT_DIR: cwd },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
    // A hook with nothing to do may exit before it reads its input; that is not a failure.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

/** Why Cursor would log this run as failed, or null when it would log a success. */
function failureOf({ code, signal, stdout }) {
  if (signal) return `killed by ${signal}`
  if (code !== 0) return `exit ${code}`
  const text = stdout.trim()
  if (!text) return 'printed nothing (empty_stdout)'
  try {
    const answer = JSON.parse(text)
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return `answer is not a JSON object: ${text.slice(0, 120)}`
  } catch {
    return `answer is not JSON (invalid_json): ${text.slice(0, 120)}`
  }
  return null
}

/** Every hook command in hooks.json with its event, run for each input in `state`. */
async function runAll(shell, state, concurrency = 4) {
  const jobs = []
  for (const [event, entries] of Object.entries(HOOKS)) {
    for (const entry of entries) {
      const where = homeIn(state)
      for (const input of inputsFor(event, where)) jobs.push({ event, command: entry.command, input, where })
    }
  }
  const failures = []
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const run = await runHook(shell, job.command, job.input, job.where)
      const failure = failureOf(run)
      if (failure) failures.push(`${job.event} (${job.input.tool_name ?? 'no tool'}): ${failure}\n  ${job.command}\n  ${run.stderr.trim().slice(0, 300)}`)
    }
  }))
  return { runs: jobs.length, failures }
}

describe('every hook in hooks.json answers Cursor and exits 0', () => {
  it('finds its subjects in hooks.json', () => {
    const count = Object.values(HOOKS).reduce((n, entries) => n + entries.length, 0)
    assert.ok(count >= 40, `${count} hook commands`)
    assert.ok(SHELLS.includes('sh'))
  })

  for (const state of ['signed_out', 'connected', 'mid_turn']) {
    it(`in sh, ${state.replace('_', ' ')}`, async () => {
      const { runs, failures } = await runAll('sh', state)
      assert.ok(runs > 0)
      assert.deepEqual(failures, [], failures.join('\n\n'))
    })
  }

  // The person's own shell: Cursor runs hooks in it. zsh is macOS's default.
  for (const shell of SHELLS.filter((s) => s !== 'sh')) {
    it(`in ${shell}, connected with nothing pending`, async () => {
      const { failures } = await runAll(shell, 'connected')
      assert.deepEqual(failures, [], failures.join('\n\n'))
    })
  }
})
