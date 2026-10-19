#!/usr/bin/env node
/**
 * A pin written in a form nothing reads is caught at the write (item fa9b809b).
 * Run: node --test hooks/scripts/pin-check.test.mjs
 *
 * Observed 2026-09-23: Haiku 4.5, asked to "pin this folder to DevSpec project <id>",
 * wrote {"projectId": ...} three runs out of four, and the folder silently never linked.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { candidatePins, checkPinAfterTool, pinProblem } from './pin-check.mjs'
import { findProjectPin } from './devspec-scope.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const ID = 'b8163b09-57ec-492d-ad3b-a8e65aba40a7'
const tmp = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmp.push(dir)
  return dir
}
after(() => {
  for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true })
})

function folderWithPin(text) {
  const home = tmpDir('devspec-pincheck-')
  const folder = path.join(home, 'app')
  fs.mkdirSync(path.join(folder, '.devspec'), { recursive: true })
  const file = path.join(folder, '.devspec', 'project.json')
  fs.writeFileSync(file, text)
  return { home, folder, file }
}

describe('what counts as a pin', () => {
  it('agrees with the reader on every case it judges', () => {
    const cases = [
      [`{"project_id": "${ID}"}`, true],
      [`{"project_id": "${ID}", "project_name": "Greenfield"}`, true],
      [`{"projectId": "${ID}"}`, false],
      [`{"project_id": ""}`, false],
      ['not json', false],
      [`["${ID}"]`, false],
    ]
    for (const [text, readable] of cases) {
      const { home, folder } = folderWithPin(text)
      const readerAccepts = Boolean(findProjectPin(folder, { home, root: folder }))
      assert.equal(readerAccepts, readable, `reader on ${text}`)
      if (!readable) assert.ok(pinProblem(text), `check flags ${text}`)
    }
  })

  it('also flags keys that would make the file unsafe to commit', () => {
    assert.match(pinProblem(`{"project_id": "${ID}", "path": "/home/me/app"}`), /"path"/)
    assert.equal(pinProblem(`{"project_id": "${ID}"}`), null)
  })
})

describe('which files a tool call could have written', () => {
  it('a Write or Edit to .devspec/project.json, resolved against the cwd', () => {
    assert.deepEqual(candidatePins({ tool_name: 'Write', cwd: '/w', tool_input: { file_path: '.devspec/project.json' } }), [
      path.resolve('/w/.devspec/project.json'),
    ])
    assert.deepEqual(candidatePins({ tool_name: 'Edit', cwd: '/w', tool_input: { file_path: '/w/src/project.json' } }), [])
  })

  it('a Shell or Bash command that names the file: the cwd and the repository root', () => {
    const got = candidatePins(
      { tool_name: 'Shell', cwd: '/w/sub', tool_input: { command: "printf '{}' > .devspec/project.json" } },
      { root: () => '/w' },
    )
    assert.deepEqual(got, [path.join('/w/sub', '.devspec', 'project.json'), path.join('/w', '.devspec', 'project.json')])
    assert.deepEqual(candidatePins({ tool_name: 'Shell', cwd: '/w', tool_input: { command: 'ls' } }), [])
  })
})

describe('the correction', () => {
  it('tells the model exactly what to write, with the id it used', () => {
    const { folder, file } = folderWithPin(`{\n  "projectId": "${ID}"\n}\n`)
    const out = checkPinAfterTool({ tool_name: 'Write', cwd: folder, tool_input: { file_path: file } })
    const text = out?.hookSpecificOutput?.additionalContext
    assert.equal(out?.hookSpecificOutput?.hookEventName, 'PostToolUse')
    assert.equal(out?.additional_context, text)
    assert.match(text, /"project_id"/)
    assert.ok(text.includes(`{"project_id": "${ID}"}`), text)
  })

  it('is silent for a good pin and for a file that is not there', () => {
    const { folder, file } = folderWithPin(`{"project_id": "${ID}"}`)
    assert.equal(checkPinAfterTool({ tool_name: 'Write', cwd: folder, tool_input: { file_path: file } }), null)
    assert.equal(checkPinAfterTool({ tool_name: 'Write', cwd: folder, tool_input: { file_path: '/nope/.devspec/project.json' } }), null)
  })
})

describe('the hooks.json commands, run the way Cursor runs them', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.postToolUse
  const command = (matcher, script) =>
    hooks.find((e) => e.matcher === matcher && e.command.includes(script)).command
  const runHook = (cmd, input) =>
    execFileSync('sh', ['-c', cmd], {
      input: JSON.stringify(input),
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: ROOT, HOME: tmpDir('devspec-hookhome-') },
      encoding: 'utf8',
    })

  it('the Write|Edit pin check reaches node and speaks for a bad pin', () => {
    const { folder, file } = folderWithPin(`{"projectId": "${ID}"}`)
    const out = runHook(command('^(Write|Edit|MultiEdit|ApplyPatch|apply_patch)$', 'pin-check.mjs'), {
      tool_name: 'Write',
      cwd: folder,
      tool_input: { file_path: file },
    })
    assert.match(out, /"additionalContext":"DevSpec cannot use the pin/)
  })

  // The filter is what keeps these hooks free on ordinary calls, so test it directly:
  // swap the node call for a probe that says whether it ran.
  const probe = (cmd) => cmd.replace(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/[\w-]+\.mjs"/, 'cat >/dev/null; echo RAN')

  it('the pin check starts node only when the input mentions the pin', () => {
    const cmd = probe(command('^(Write|Edit|MultiEdit|ApplyPatch|apply_patch)$', 'pin-check.mjs'))
    assert.notEqual(cmd, command('^(Write|Edit|MultiEdit|ApplyPatch|apply_patch)$', 'pin-check.mjs'), 'probe substituted')
    assert.equal(runHook(cmd, { tool_name: 'Edit', cwd: '/w', tool_input: { file_path: '/w/src/app.ts' } }), '')
    assert.equal(runHook(cmd, { tool_name: 'Write', cwd: '/w', tool_input: { file_path: '/w/.devspec/project.json' } }).trim(), 'RAN')
    const shell = probe(command('^(Bash|Shell)$', 'pin-check.mjs'))
    assert.equal(runHook(shell, { tool_name: 'Shell', cwd: '/w', tool_input: { command: 'npm test' } }), '')
  })

  it('the repo-link reminder starts node only for commands that could add a remote', () => {
    const cmd = probe(command('^(Bash|Shell)$', 'repo-link-nudge.mjs'))
    assert.equal(runHook(cmd, { tool_name: 'Shell', cwd: '/w', tool_input: { command: 'npm test' } }), '')
    assert.equal(runHook(cmd, { tool_name: 'Shell', cwd: '/w', tool_input: { command: 'git remote add origin x' } }).trim(), 'RAN')
    assert.equal(runHook(cmd, { tool_name: 'Shell', cwd: '/w', tool_input: { command: 'gh repo create app --source=.' } }).trim(), 'RAN')
  })
})
