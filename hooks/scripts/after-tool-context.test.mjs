#!/usr/bin/env node
/**
 * Every after-tool hook in hooks.json, run together for one tool call the way Cursor
 * runs them, each with the longest context it can have waiting. Cursor joins their
 * answers and drops the lot once the joined text passes its ceiling
 * (hook-context-budget.mjs), so this is the check that no hook can take the others
 * down with it. The hooks come from hooks.json itself, so a new one is run too.
 * Run: node --test hooks/scripts/after-tool-context.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import {
  CURSOR_HOOK_CONTEXT_MAX_CHARS,
  CURSOR_HOOK_CONTEXT_SEPARATOR,
  POST_TOOL_CONTEXT_HOOKS,
  POST_TOOL_CONTEXT_SHARE,
} from './hook-context-budget.mjs'
import { leaveTellPersonNote } from './notice-reply.mjs'
import { writePrivateJson, writePrivateText } from './private-state.mjs'
import { contextFile, selectProjectContext } from './project-context.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const AFTER_TOOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.postToolUse
const CONVERSATION = 'cursor-conversation-after-tool'
const CONN = '11111111-2222-4333-8444-555555555555'
const SESSION = '66666666-7777-4888-9999-000000000000'
const PROJECT = { id: '24c4abaa-2cb9-496a-8492-cf1f1aa1090b', name: 'Greenfield' }
const TOOL_USE = 'tool-use-after-tool-1'
const ENDPOINT = 'http://127.0.0.1:9/api/mcp'

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** A home where every after-tool hook that can speak has its longest note waiting. */
function worstCaseHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-after-tool-'))
  roots.push(home)
  const remote = path.join(home, '.devspec', 'remote-control')
  const connections = path.join(remote, 'connections')

  // Project and repository context: many repositories and very long rules, as the
  // connect step stores them for this conversation.
  selectProjectContext(CONVERSATION, ENDPOINT, PROJECT, 'explicit', home)
  writePrivateJson(`${contextFile(CONVERSATION, home)}.repositories`, {
    project_id: PROJECT.id,
    project_name: PROJECT.name,
    repository_context: {
      status: 'available',
      repositories: Array.from({ length: 200 }, (_, i) => ({
        id: `r${i}`, full_name: `greenfield/repo-${i}`, provider: 'github',
        git_url: `https://example.test/greenfield/repo-${i}.git`, target_branch: 'staging', default_branch: 'main',
      })),
    },
    rules: {
      project_custom_instructions: null,
      project_agent_rules: `${'Always run the checks. '.repeat(2_000)}RULES-END`,
      owner_agent_rules: 'Machine rules',
    },
  })

  // This conversation's connection, attached to a room.
  writePrivateJson(path.join(remote, 'local', 'cursor', `${CONVERSATION}.json`), { connection_id: CONN })
  writePrivateJson(path.join(connections, `${CONN}.json`), {
    connection_id: CONN, enabled: true, agent_name: 'Cursor', local_id: CONVERSATION, session_id: SESSION,
  })

  // A long message the person has not heard.
  leaveTellPersonNote(CONN, { text: `I closed ${'a duplicate task; '.repeat(1_200)}TELL-END`, dir: connections })

  // A room where hundreds of people have written since the agent last read it.
  writePrivateJson(path.join(connections, `${CONN}.${SESSION}.transcript-state.json`), { version: 1, self_label: 'Cursor · Amber Dolphin' })
  const lines = Array.from({ length: 600 }, (_, i) => ({
    seq: i + 1,
    at: '2026-11-20T13:00:00.000Z',
    message_id: `m-${i + 1}`,
    from: { label: `Teammate number ${i + 1} with a long display name`, kind: 'human' },
    to: null,
    text: `message ${i + 1}`,
    attachments: [],
    state: 'final',
  }))
  writePrivateText(path.join(connections, `${CONN}.${SESSION}.transcript.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

  // A commit note waiting for this tool call, where the commit hook keeps it.
  writePrivateJson(
    path.join(home, '.devspec', 'cursor-provenance-state', `${createHash('sha256').update(CONVERSATION).digest('hex')}.json`),
    {
      conversation_id: CONVERSATION,
      pending_notes: { [TOOL_USE]: { text: `DevSpec commit note: ${'x'.repeat(20_000)} NOTE-END`, at: new Date().toISOString() } },
    },
  )
  return home
}

/** The folder the tool call ran in, with a pin that names thousands of keys it must not hold. */
function folderWithBadPin(home) {
  const folder = path.join(home, 'work')
  const extra = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`unexpected_key_${i}`, i]))
  fs.mkdirSync(path.join(folder, '.devspec'), { recursive: true })
  fs.writeFileSync(path.join(folder, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT.id, ...extra }))
  return folder
}

function matches(entry, tool) {
  return !entry.matcher || new RegExp(entry.matcher).test(tool)
}

/** Each hook's stdout for one tool call, run as Cursor runs it. */
function runHooks(home, input) {
  return AFTER_TOOL.filter((entry) => matches(entry, input.tool_name)).map((entry) => {
    const run = spawnSync('sh', ['-c', entry.command], {
      input: JSON.stringify(input),
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: ROOT,
        CURSOR_CONVERSATION_ID: CONVERSATION,
        // Nothing here may reach a real DevSpec: any address it tried would refuse at once.
        DEVSPEC_MCP_URL: ENDPOINT,
        DEVSPEC_API_URL: 'http://127.0.0.1:9',
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    // A hook that has nothing to do may exit before it reads the tool call (EPIPE on
    // the input); that is not a failure. Anything else is.
    if (run.error && run.error.code !== 'EPIPE') throw run.error
    assert.equal(run.status, 0, `${entry.command}\n${run.stderr}`)
    return { command: entry.command, stdout: run.stdout ?? '' }
  })
}

/** The context in one hook's stdout, as Cursor reads it, or null. */
function contextOf(stdout) {
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed?.additional_context === 'string') return parsed.additional_context
      if (typeof parsed?.hookSpecificOutput?.additionalContext === 'string') return parsed.hookSpecificOutput.additionalContext
    } catch {
      /* not hook output */
    }
  }
  return null
}

const pointedFile = (context) => {
  const match = context.match(/at ("[^"]+"): nothing in that file is cut/)
  return match ? JSON.parse(match[1]) : null
}

describe('every after-tool hook, together, at its longest', () => {
  it("stays within Cursor's ceiling for one tool call, and hands over everything whole", () => {
    const home = worstCaseHome()
    const folder = folderWithBadPin(home)
    const input = {
      conversation_id: CONVERSATION,
      tool_name: 'Shell',
      tool_use_id: TOOL_USE,
      cwd: folder,
      tool_input: { command: 'cat .devspec/project.json && git remote -v' },
      tool_output: '',
    }
    const answers = runHooks(home, input)
      .map(({ command, stdout }) => ({ command, context: contextOf(stdout) }))
      .filter((answer) => answer.context !== null)

    for (const { command, context } of answers) {
      assert.ok(context.length <= POST_TOOL_CONTEXT_SHARE, `${context.length} characters from: ${command}`)
    }
    const joined = answers.map((answer) => answer.context.trim()).join(CURSOR_HOOK_CONTEXT_SEPARATOR)
    assert.ok(joined.length <= CURSOR_HOOK_CONTEXT_MAX_CHARS, `${joined.length} characters together`)
    assert.ok(answers.length <= POST_TOOL_CONTEXT_HOOKS, `${answers.length} hooks answered; the share is counted for ${POST_TOOL_CONTEXT_HOOKS}`)

    // Every seeded note was handed over, each whole in the file its pointer names.
    const files = answers.map((answer) => pointedFile(answer.context)).filter(Boolean)
    const whole = files.map((file) => fs.readFileSync(file, 'utf8'))
    for (const end of ['RULES-END', 'TELL-END', 'NOTE-END', 'Teammate number 600', 'unexpected_key_1999']) {
      assert.ok(whole.some((text) => text.includes(end)), `${end} handed over whole`)
    }
    assert.equal(answers.length, 5, answers.map((answer) => answer.command).join('\n'))
  })
})
