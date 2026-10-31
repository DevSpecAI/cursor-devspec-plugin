/**
 * The git stand-in for Cursor (item c2a7ab72), run for real: the preToolUse line is
 * put in front of a command, the command runs in bash (and zsh where installed) the
 * way Cursor's shell runs it (`builtin eval "$1"`), the stand-in runs the real git, and
 * the reporting hook sends what it noted. Nothing here reads source text.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import {
  PREFIX_MARKER,
  findRealGit,
  prepareStandIn,
  stripStandInPrefix,
  withoutStandInPrefix,
} from './git-observer.mjs'
import { MAX_ATTEMPTS, commitsLogPath, reportCommits, sanitizeRemote } from './commit-reports.mjs'
import {
  MAX_STAND_IN_DEPTH,
  STAND_IN_MARKER,
  loopStoppedText,
  normalizeRemoteKey,
  parseCommitArgs,
  tagSubject,
} from './git-stand-in.mjs'
import { selectProjectContext } from './project-context.mjs'
import { storeRepositorySnapshot } from './repository-context.mjs'
import { handleBashPost as observationPost, handleBashPre as observationPre } from './commit-observation.mjs'
import { handleHook } from './provenance-assistance.mjs'
import { renderHookTrailPart } from './work-trail.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONVERSATION = 'cursor-chat-1'
const CONNECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const TASK_A = '33333333-3333-4333-8333-333333333333'
const TASK_B = '44444444-4444-4444-8444-444444444444'
const ENDPOINT = 'https://devspec.test/api/mcp'
const PROJECT_ORIGIN = 'git@github.com:acme/app.git'
const ZSH = spawnSync('zsh', ['-c', 'exit 0']).status === 0
const roots = []
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) })

function tempDir(prefix = 'cursor-stand-in-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

/** A home with a live connection bound to the conversation, its project and repositories. */
function connectedHome({ enabled = true } = {}) {
  const home = tempDir('cursor-stand-in-home-')
  const connections = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connections, { recursive: true })
  fs.writeFileSync(path.join(connections, `${CONNECTION}.json`), JSON.stringify({
    enabled, connection_id: CONNECTION, local_id: CONVERSATION, agent_name: 'Cursor', project_id: PROJECT,
    token: 'fixture-secret-token', mcp_url: ENDPOINT, connection_capability: 'fixture-capability',
  }))
  selectProjectContext(CONVERSATION, ENDPOINT, { id: PROJECT, name: 'App', organization: { id: PROJECT, name: 'Org' } }, 'conversation', home)
  storeRepositorySnapshot(CONVERSATION, {
    project_id: PROJECT,
    repository_context: {
      version: 1, project_id: PROJECT, status: 'available',
      repositories: [{ id: 'repo-1', full_name: 'acme/app', provider: 'github', git_url: 'https://github.com/acme/app.git', target_branch: null, default_branch: 'main' }],
    },
  }, home)
  return home
}

const GIT = findRealGit(process.env, os.homedir())
const git = (cwd, ...args) => execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function makeRepo({ origin = PROJECT_ORIGIN, pin = null } = {}) {
  const repo = path.join(tempDir('cursor-stand-in-repo-'), 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'commit.gpgsign', 'false')
  if (origin) git(repo, 'remote', 'add', 'origin', origin)
  if (pin) {
    fs.mkdirSync(path.join(repo, '.devspec'))
    fs.writeFileSync(path.join(repo, '.devspec', 'project.json'), JSON.stringify({ project_id: pin }))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.devspec/\n')
  }
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
  return repo
}

function prepared(home, command, claims = [TASK_A]) {
  const result = prepareStandIn({
    command,
    conversationId: CONVERSATION,
    projectId: PROJECT,
    claims: claims.map((id) => ({ id, project_id: PROJECT })),
    home,
  })
  assert.ok(result, 'the stand-in line applies')
  return result.command
}

/**
 * Run a command the way Cursor's shell does, with the person's PATH and a home: its
 * bash and zsh shells evaluate the command (`builtin eval "$1"`); with neither, it
 * hands the command to the person's shell with -c.
 */
function inShell(command, { cwd, home, shell = 'bash', input = undefined, env = {} }) {
  const args = shell === 'sh' ? ['-c', command] : ['-c', 'builtin eval "$1"', '--', command]
  return spawnSync(shell, args, {
    cwd, input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...env },
  })
}

async function report(home, call = async () => ({ recorded: true })) {
  const calls = []
  const outcomes = await reportCommits({ home, call: async (request) => { calls.push(request); return call(request) } })
  return { calls, outcomes }
}

function commitsLog(home) {
  try {
    return fs.readFileSync(commitsLogPath(CONNECTION, home), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

describe('the line in front of a Shell command', () => {
  it('is taken back off for every reader of the command, and nothing else is', () => {
    const home = connectedHome()
    const command = 'npm test && git commit -m "x"'
    const line = prepared(home, command)
    assert.ok(line.endsWith(`\n${command}`))
    assert.ok(line.split('\n')[0].endsWith(PREFIX_MARKER))
    assert.deepEqual(stripStandInPrefix(line), { command, observed: true })
    assert.deepEqual(stripStandInPrefix(command), { command, observed: false })
    // postToolUse carries the rewritten tool input; the shell hooks carry `command`.
    assert.deepEqual(withoutStandInPrefix({ tool_input: { command: line, cwd: '/w' } }), { payload: { tool_input: { command, cwd: '/w' } }, observed: true })
    assert.deepEqual(withoutStandInPrefix({ tool_input: JSON.stringify({ command: line }) }).payload, { tool_input: JSON.stringify({ command }) })
    assert.deepEqual(withoutStandInPrefix({ command: line }), { payload: { command }, observed: true })
    // A line the agent wrote itself is not this one.
    const own = "export PATH=/x:$PATH\ngit status"
    assert.equal(stripStandInPrefix(own).observed, false)
  })

  it('carries no connection id, key or identity, and a second rewrite is never stacked', () => {
    const home = connectedHome()
    const line = prepared(home, 'git status')
    assert.doesNotMatch(line, new RegExp(CONNECTION))
    assert.doesNotMatch(line, /fixture-secret-token|fixture-capability|cursor-chat-1/)
    assert.doesNotMatch(line, new RegExp(PROJECT))
    assert.equal(prepareStandIn({ command: line, conversationId: CONVERSATION, home }), null)
  })

  it('applies only to a live connection bound to this conversation, and never on native Windows', () => {
    const home = connectedHome()
    assert.equal(prepareStandIn({ command: 'git status', conversationId: CONVERSATION, home, platform: 'win32' }), null)
    assert.equal(prepareStandIn({ command: 'git status', conversationId: 'another-chat', home }), null)
    assert.equal(prepareStandIn({ command: 'git status', conversationId: CONVERSATION, home: tempDir() }), null)
    assert.equal(prepareStandIn({ command: 'git status', conversationId: CONVERSATION, home: connectedHome({ enabled: false }) }), null)
    assert.equal(prepareStandIn({ command: '   ', conversationId: CONVERSATION, home }), null)
  })

  for (const shell of ZSH ? ['bash', 'zsh', 'sh'] : ['bash', 'sh']) {
    it(`puts the stand-in first on PATH once in ${shell}, and keeps the command's output and exit code`, () => {
      const home = connectedHome()
      const repo = makeRepo()
      const plain = inShell('git status --short --branch; exit 3', { cwd: repo, home, shell })
      // Cursor keeps one shell's environment from command to command: run the line twice.
      const twice = `${prepared(home, 'true')}\n${prepared(home, 'command -v git; printf "%s" "$PATH"; echo; git status --short --branch; exit 3')}`
      const result = inShell(twice, { cwd: repo, home, shell })
      assert.equal(result.status, 3)
      const [where, pathLine, ...status] = result.stdout.split('\n')
      assert.match(where, /\.devspec\/cursor-git-stand-in\/[0-9a-f]{32}\/git$/)
      const folder = path.dirname(where)
      assert.equal(pathLine.split(':').filter((entry) => entry === folder).length, 1)
      assert.equal(status.join('\n'), plain.stdout)
      assert.equal(result.stderr, plain.stderr)
    })
  }
})

describe('commits in the connected project\'s repositories', () => {
  it('tags a multi-line -m commit with the one claimed task, says so, and reports it from git', async () => {
    const home = connectedHome()
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    const result = inShell(prepared(home, "git add a.txt && git commit -q -m 'Add a\n\nBecause it is needed.'"), { cwd: repo, home })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, new RegExp(`added \\[devspec:${TASK_A}\\] to the end of this commit's subject line`))
    assert.equal(git(repo, 'log', '-1', '--format=%B'), `Add a [devspec:${TASK_A}]\n\nBecause it is needed.`)
    const sha = git(repo, 'rev-parse', 'HEAD')

    const { calls, outcomes } = await report(home)
    assert.deepEqual(outcomes.map((o) => o.outcome), ['sent'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'report_commit_provenance')
    assert.equal(calls[0].token, 'fixture-secret-token')
    assert.equal(calls[0].connectionCapability, 'fixture-capability')
    assert.deepEqual({ ...calls[0].arguments, observation_id: undefined }, {
      connection_id: CONNECTION, commit_sha: sha, branch: 'main', git_remote: PROJECT_ORIGIN, observation_id: undefined,
    })
    assert.match(calls[0].arguments.observation_id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(commitsLog(home).map((e) => [e.outcome, e.commit_sha, e.amend]), [['observed', sha, false], ['sent', sha, false]])
    // Reported once: a second hook has nothing left to send.
    assert.equal((await report(home)).calls.length, 0)
  })

  it('tags a message file through a private copy and leaves the person\'s file as it was', async () => {
    const home = connectedHome()
    const repo = makeRepo()
    const file = path.join(path.dirname(repo), 'MSG.txt')
    fs.writeFileSync(file, 'From a file\n\nWith a body.\n')
    const result = inShell(prepared(home, `git commit -q --allow-empty -F ${JSON.stringify(file)}`), { cwd: repo, home })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(file, 'utf8'), 'From a file\n\nWith a body.\n')
    assert.equal(git(repo, 'log', '-1', '--format=%s'), `From a file [devspec:${TASK_A}]`)
    assert.equal((await report(home)).calls.length, 1)
  })

  it('tags a message read from standard input (a heredoc), and git gets every byte', async () => {
    const home = connectedHome()
    const repo = makeRepo()
    const command = "git commit -q --allow-empty -F - <<'MSG'\nFrom stdin\n\nLine two\n  indented line\nMSG"
    const result = inShell(prepared(home, command), { cwd: repo, home })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(git(repo, 'log', '-1', '--format=%B'), `From stdin [devspec:${TASK_A}]\n\nLine two\n  indented line`)
  })

  it('notices a commit made inside a script and in a linked worktree, and reports each with its full id', async () => {
    const home = connectedHome()
    const repo = makeRepo()
    const script = path.join(path.dirname(repo), 'ship.sh')
    fs.writeFileSync(script, '#!/bin/sh\nset -e\necho change >> b.txt\ngit add b.txt\ngit commit -q -m "From a script"\n')
    fs.chmodSync(script, 0o755)
    const viaScript = inShell(prepared(home, `sh ${JSON.stringify(script)}`), { cwd: repo, home })
    assert.equal(viaScript.status, 0, viaScript.stderr)
    const scriptSha = git(repo, 'rev-parse', 'HEAD')
    assert.equal(git(repo, 'log', '-1', '--format=%s'), `From a script [devspec:${TASK_A}]`)

    const linked = path.join(path.dirname(repo), 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked)
    const inWorktree = inShell(prepared(home, `cd ${JSON.stringify(linked)} && git commit -q --allow-empty -m "In a worktree"`), { cwd: repo, home })
    assert.equal(inWorktree.status, 0, inWorktree.stderr)
    const worktreeSha = git(linked, 'rev-parse', 'HEAD')

    const { calls } = await report(home)
    assert.deepEqual(calls.map((c) => [c.arguments.commit_sha, c.arguments.branch, c.arguments.git_remote]), [
      [scriptSha, 'main', PROJECT_ORIGIN],
      [worktreeSha, 'feature', PROJECT_ORIGIN],
    ])
  })

  it('brings a repository with no origin into scope by its pin, also from a linked worktree, and reports the pin', async () => {
    const home = connectedHome()
    const repo = makeRepo({ origin: null, pin: PROJECT })
    const linked = path.join(path.dirname(repo), 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'pinned', linked)
    const result = inShell(prepared(home, 'git commit -q --allow-empty -m "Pinned work"'), { cwd: linked, home })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(git(linked, 'log', '-1', '--format=%s'), `Pinned work [devspec:${TASK_A}]`)
    const { calls } = await report(home)
    assert.deepEqual(calls.map((c) => c.arguments), [{
      connection_id: CONNECTION, commit_sha: git(linked, 'rev-parse', 'HEAD'), branch: 'pinned',
      observation_id: calls[0].arguments.observation_id, pinned_project_id: PROJECT,
    }])
  })

  it('stops an untagged commit before git runs when no task is claimed, and the repository is unchanged', async () => {
    const home = connectedHome()
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n')
    git(repo, 'add', 'c.txt')
    const head = git(repo, 'rev-parse', 'HEAD')
    const index = git(repo, 'diff', '--cached', '--name-only')
    const result = inShell(prepared(home, 'git commit -q -m "Unclaimed"', []), { cwd: repo, home })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /DevSpec stopped this commit before git ran, so nothing was changed/)
    assert.match(result.stderr, /claim_work_item/)
    assert.match(result.stderr, /create_task/)
    assert.match(result.stderr, /retry the same commit: its \[devspec:<id>\] reference is added for you/)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), index)
    assert.equal((await report(home)).calls.length, 0)
  })

  it('stops an untagged commit when several tasks are claimed, and names their references', () => {
    const home = connectedHome()
    const repo = makeRepo()
    const head = git(repo, 'rev-parse', 'HEAD')
    const result = inShell(prepared(home, 'git commit -q --allow-empty -m "Which one"', [TASK_A, TASK_B]), { cwd: repo, home })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /2 tasks are claimed/)
    assert.match(result.stderr, new RegExp(`claimed: \\[devspec:${TASK_A}\\], \\[devspec:${TASK_B}\\]`))
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
  })

  it('runs an existing reference, an amend and a reused message exactly as asked, and still reports them', async () => {
    const home = connectedHome()
    const repo = makeRepo()
    const tagged = inShell(prepared(home, `git commit -q --allow-empty -m "Mine [devspec:${TASK_B}]"`), { cwd: repo, home })
    assert.equal(tagged.status, 0, tagged.stderr)
    assert.equal(git(repo, 'log', '-1', '--format=%s'), `Mine [devspec:${TASK_B}]`)
    assert.doesNotMatch(tagged.stderr, /DevSpec/)

    const amended = inShell(prepared(home, 'git commit -q --amend --allow-empty -m "Amended, no tag"', []), { cwd: repo, home })
    assert.equal(amended.status, 0, amended.stderr)
    assert.equal(git(repo, 'log', '-1', '--format=%s'), 'Amended, no tag')

    const reused = inShell(prepared(home, 'git commit -q --allow-empty -C HEAD', []), { cwd: repo, home })
    assert.equal(reused.status, 0, reused.stderr)

    const { calls } = await report(home)
    assert.equal(calls.length, 3)
    assert.deepEqual(commitsLog(home).filter((e) => e.outcome === 'sent').map((e) => e.amend), [false, true, false])
  })

  it('keeps Cursor\'s co-author trailer and the agent\'s own options', () => {
    const home = connectedHome()
    const repo = makeRepo()
    const command = 'git commit -q --allow-empty --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "With trailer"'
    const result = inShell(prepared(home, command), { cwd: repo, home })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(git(repo, 'log', '-1', '--format=%B'), `With trailer [devspec:${TASK_A}]\n\nCo-authored-by: Cursor <cursoragent@cursor.com>`)
  })

  if (ZSH) {
    it('works the same in zsh, the shell Cursor uses when it is the person\'s login shell', async () => {
      const home = connectedHome()
      const repo = makeRepo()
      const result = inShell(prepared(home, "git commit -q --allow-empty -m 'In zsh\n\nbody'"), { cwd: repo, home, shell: 'zsh' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(git(repo, 'log', '-1', '--format=%s'), `In zsh [devspec:${TASK_A}]`)
      assert.equal((await report(home)).calls.length, 1)
    })
  }
})

describe('everything else is left alone', () => {
  it('a repository that is not the project\'s gets git exactly as asked: no tag, no check, nothing reported', async () => {
    const home = connectedHome()
    const repo = makeRepo({ origin: 'https://github.com/someone/else.git' })
    const unclaimed = inShell(prepared(home, 'git commit -q --allow-empty -m "Elsewhere"', []), { cwd: repo, home })
    assert.equal(unclaimed.status, 0, unclaimed.stderr)
    assert.equal(unclaimed.stderr, '')
    const claimed = inShell(prepared(home, 'git commit -q --allow-empty -m "Elsewhere again"'), { cwd: repo, home })
    assert.equal(claimed.status, 0, claimed.stderr)
    assert.equal(git(repo, 'log', '-2', '--format=%s'), 'Elsewhere again\nElsewhere')
    // Git is not even asked to describe what it did: an alias that prints git's own
    // environment shows no trace request there, where in the project's repository it does.
    const gitEnv = (cwd) => inShell(prepared(home, "git -c alias.showenv='!env' showenv | grep -c '^GIT_TRACE2_EVENT=' || true"), { cwd, home }).stdout.trim()
    assert.equal(gitEnv(repo), '0')
    assert.equal(gitEnv(makeRepo()), '1')
    assert.equal((await report(home)).calls.length, 0)
    assert.deepEqual(commitsLog(home), [])
  })

  it('standard input, output and exit codes pass through git unchanged', () => {
    const home = connectedHome()
    const repo = makeRepo()
    const bytes = 'some bytes\nwith two lines\n'
    const env = { PATH: process.env.PATH, HOME: home }
    const plain = spawnSync(GIT, ['hash-object', '--stdin'], { cwd: repo, input: bytes, encoding: 'utf8', env })
    const viaStandIn = inShell(prepared(home, 'git hash-object --stdin'), { cwd: repo, home, input: bytes })
    assert.equal(viaStandIn.stdout, plain.stdout)
    assert.equal(viaStandIn.status, 0)
    // Nothing to commit: git's own failure, word for word.
    const failing = spawnSync(GIT, ['commit', '-m', `x [devspec:${TASK_A}]`], { cwd: repo, encoding: 'utf8', env })
    const viaFailing = inShell(prepared(home, `git commit -m "x [devspec:${TASK_A}]"`), { cwd: repo, home })
    assert.equal(viaFailing.status, failing.status)
    assert.equal(viaFailing.stdout, failing.stdout)
    assert.equal(viaFailing.stderr, failing.stderr)
    const unknown = inShell(prepared(home, 'git no-such-command'), { cwd: repo, home })
    assert.equal(unknown.status, spawnSync(GIT, ['no-such-command'], { cwd: repo, env }).status)
  })

  it('runs the git the command\'s own PATH leads to, not one found elsewhere', () => {
    const home = connectedHome()
    const repo = makeRepo()
    // The hook found one git; the agent's shell has another first on its PATH.
    const alt = tempDir('cursor-alt-git-')
    const log = path.join(alt, 'ran.log')
    fs.writeFileSync(path.join(alt, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(GIT)} "$@"\n`, { mode: 0o755 })
    const result = inShell(prepared(home, 'git rev-parse --is-inside-work-tree'), { cwd: repo, home, env: { PATH: `${alt}:${process.env.PATH}` } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'true')
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'rev-parse --is-inside-work-tree')
  })

  it('a command run after the connection ended runs git straight through, even with the folder still on PATH', async () => {
    const home = connectedHome()
    const repo = makeRepo()
    const line = prepared(home, 'git commit -q --allow-empty -m "After the end"', [])
    const state = path.join(home, '.devspec', 'remote-control', 'connections', `${CONNECTION}.json`)
    fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, 'utf8')), enabled: false }))
    const result = inShell(line, { cwd: repo, home })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(git(repo, 'log', '-1', '--format=%s'), 'After the end')
    assert.equal((await report(home)).calls.length, 0)
  })
})

describe('living alongside another DevSpec plugin\'s stand-in', () => {
  it('never takes a marked stand-in for git, and runs normally beside one', () => {
    const home = connectedHome()
    const repo = makeRepo()
    const foreign = tempDir('cursor-foreign-')
    // Another plugin's stand-in: it hands every call to the next git on PATH.
    fs.writeFileSync(path.join(foreign, 'git'), [
      '#!/bin/sh',
      `${STAND_IN_MARKER}: another DevSpec plugin's stand-in`,
      `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF '${foreign}' | paste -sd: -)`,
      'exec git "$@"',
      '',
    ].join('\n'), { mode: 0o755 })
    const env = { PATH: `${foreign}:${process.env.PATH}` }
    assert.notEqual(path.dirname(findRealGit(env, home)), foreign)
    // Behind ours (it was on PATH first), and ahead of ours (a command puts it there).
    for (const [command, subject] of [
      ['git commit -q --allow-empty -m "Behind"', 'Behind'],
      [`PATH=${JSON.stringify(foreign)}:"$PATH" git commit -q --allow-empty -m "Ahead"`, 'Ahead'],
    ]) {
      const line = prepareStandIn({ command, conversationId: CONVERSATION, projectId: PROJECT, claims: [{ id: TASK_A, project_id: PROJECT }], home, env })
      const result = spawnSync('bash', ['-c', 'builtin eval "$1"', '--', line.command], { cwd: repo, encoding: 'utf8', env: { ...env, HOME: home }, timeout: 20_000 })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(git(repo, 'log', '-1', '--format=%s'), `${subject} [devspec:${TASK_A}]`)
    }
  })

  it('a loop with an older stand-in that does not follow the agreement ends within the agreed depth', () => {
    const home = connectedHome()
    const repo = makeRepo()
    // An unmarked stand-in that takes whichever git is first on PATH: ours.
    const older = tempDir('cursor-older-')
    fs.writeFileSync(path.join(older, 'git'), '#!/bin/sh\nexec git "$@"\n', { mode: 0o755 })
    const env = { PATH: `${older}:${process.env.PATH}` }
    const line = prepareStandIn({ command: 'git status', conversationId: CONVERSATION, projectId: PROJECT, home, env })
    assert.ok(line)
    const started = Date.now()
    const result = spawnSync('bash', ['-c', 'builtin eval "$1"', '--', line.command], { cwd: repo, encoding: 'utf8', env: { ...env, HOME: home }, timeout: 60_000 })
    assert.equal(result.status, 126)
    assert.equal(result.stderr.trim(), loopStoppedText())
    assert.ok(Date.now() - started < 30_000)
    assert.equal(MAX_STAND_IN_DEPTH, 8)
  })
})

describe('reporting', () => {
  async function oneCommit(home, origin = PROJECT_ORIGIN) {
    const repo = makeRepo({ origin })
    const result = inShell(prepared(home, 'git commit -q --allow-empty -m "To report"'), { cwd: repo, home })
    assert.equal(result.status, 0, result.stderr)
    return git(repo, 'rev-parse', 'HEAD')
  }

  it('retries a report that could not be sent, and logs DevSpec\'s refusal with its reason', async () => {
    const home = connectedHome()
    const sha = await oneCommit(home)
    const down = await report(home, async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }) })
    assert.deepEqual(down.outcomes.map((o) => o.outcome), ['retry'])
    // Not due yet: the backoff holds it.
    assert.equal((await report(home)).calls.length, 0)
    const queue = path.join(home, '.devspec', 'cursor-git-stand-in')
    const folder = fs.readdirSync(queue).find((name) => /^[0-9a-f]{32}$/.test(name))
    const file = path.join(queue, folder, 'queue.json')
    const waiting = JSON.parse(fs.readFileSync(file, 'utf8'))
    waiting.reports[0].next_attempt_at = 0
    fs.writeFileSync(file, JSON.stringify(waiting))
    const refused = await report(home, async () => ({ recorded: false, message: 'This repository is not tracked on the project.' }))
    assert.deepEqual(refused.outcomes.map((o) => [o.outcome, o.reason]), [['refused', 'This repository is not tracked on the project.']])
    assert.deepEqual(commitsLog(home).map((e) => e.outcome), ['observed', 'retry', 'refused'])
    assert.equal(commitsLog(home).at(-1).commit_sha, sha)
    assert.equal(fs.existsSync(path.join(queue, folder, 'pending')), false)
  })

  it('drops a report after its attempts, and says so in the log', async () => {
    const home = connectedHome()
    await oneCommit(home)
    const queue = path.join(home, '.devspec', 'cursor-git-stand-in')
    const folder = fs.readdirSync(queue).find((name) => /^[0-9a-f]{32}$/.test(name))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await report(home, async () => { throw Object.assign(new Error('MCP HTTP 503'), { status: 503 }) })
      const file = path.join(queue, folder, 'queue.json')
      if (!fs.existsSync(file)) break
      const waiting = JSON.parse(fs.readFileSync(file, 'utf8'))
      waiting.reports[0].next_attempt_at = 0
      fs.writeFileSync(file, JSON.stringify(waiting))
    }
    await report(home)
    assert.equal(commitsLog(home).at(-1).outcome, 'dropped')
  })

  it('never sends an origin that carries credentials', async () => {
    assert.equal(sanitizeRemote('https://user:token@github.com/acme/app.git'), null)
    assert.equal(sanitizeRemote('https://github.com/acme/app.git?token=x'), null)
    assert.equal(sanitizeRemote('deploy@github.com:acme/app.git'), null)
    assert.equal(sanitizeRemote('/srv/git/app.git'), null)
    assert.equal(sanitizeRemote('git@github.com:acme/app.git'), 'git@github.com:acme/app.git')
    assert.equal(sanitizeRemote('ssh://git@github.com/acme/app.git'), 'ssh://git@github.com/acme/app.git')
    const home = connectedHome()
    await oneCommit(home, 'https://bot:secret@github.com/acme/app.git')
    const { calls } = await report(home)
    assert.equal(calls.length, 0)
    assert.equal(commitsLog(home)[0].outcome, 'skipped')
    assert.doesNotMatch(JSON.stringify(commitsLog(home)), /secret/)
  })
})

describe('the plugin\'s other hooks', () => {
  it('provenance-assistance gives Cursor the line as structured input, with no permission decision', () => {
    const home = connectedHome()
    const repo = makeRepo()
    const output = handleHook('preToolUse', {
      conversation_id: CONVERSATION, tool_name: 'Shell', tool_use_id: 'tool-1', cwd: repo,
      tool_input: { command: 'git commit -m "no claim"', cwd: repo, timeout: 30_000 },
    }, { stateRoot: tempDir(), home, projectHome: home, pinOptions: { home } })
    assert.equal(output.permission, undefined)
    assert.equal(output.updated_input.cwd, repo)
    assert.equal(output.updated_input.timeout, 30_000)
    assert.equal(stripStandInPrefix(output.updated_input.command).command, 'git commit -m "no claim"')
    // A malformed reference is still refused before anything runs.
    const malformed = handleHook('preToolUse', {
      conversation_id: CONVERSATION, tool_name: 'Shell', tool_use_id: 'tool-2', cwd: repo,
      tool_input: { command: 'git commit -m "x [devspec:short]"' },
    }, { stateRoot: tempDir(), home, projectHome: home, pinOptions: { home } })
    assert.equal(malformed.permission, 'deny')
  })

  it('the older command-text observation stands down for a command the stand-in ran', async () => {
    const home = connectedHome()
    const repo = makeRepo({ origin: null, pin: PROJECT })
    process.env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR = path.join(tempDir(), 'state')
    try {
      const state = { connection_id: CONNECTION, mcp_url: ENDPOINT, token: 't' }
      const command = 'git commit --allow-empty -q -m "once"'
      const input = { conversation_id: CONVERSATION, tool_name: 'Shell', tool_use_id: 'tool-9', cwd: repo, tool_input: { command } }
      observationPre(input, { boundConnection: () => state })
      const line = prepared(home, command)
      assert.equal(inShell(line, { cwd: repo, home }).status, 0)
      const calls = []
      await observationPost({ ...input, tool_input: { command: line } }, { boundConnection: () => state, call: async (value) => { calls.push(value) } })
      assert.equal(calls.length, 0)
      assert.equal((await report(home)).calls.length, 1)
    } finally {
      delete process.env.DEVSPEC_CURSOR_PROVENANCE_STATE_DIR
    }
  })

  it('the room\'s work trail shows the command the agent wrote', () => {
    const home = connectedHome()
    const line = prepared(home, 'npm test')
    assert.equal(renderHookTrailPart('beforeShellExecution', { command: line }), '$ npm test\n  … running')
    assert.match(renderHookTrailPart('postToolUse', { tool_name: 'Shell', tool_input: { command: line } }), /^\$ Shell npm test/)
  })

  it('the reporting hook starts Node only when the stand-in left something to report', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    const entries = [...hooks.postToolUse, ...hooks.stop].filter((entry) => entry.command.includes('commit-reports.mjs'))
    assert.equal(entries.length, 2)
    const probe = entries[0].command.replace(/command -v node[^;]*commit-reports\.mjs\\?"?/, 'echo RAN')
    assert.notEqual(probe, entries[0].command)
    const home = tempDir()
    const run = () => execFileSync('sh', ['-c', probe], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: ROOT } }).trim()
    assert.equal(run(), '')
    const folder = path.join(home, '.devspec', 'cursor-git-stand-in', '0'.repeat(32))
    fs.mkdirSync(folder, { recursive: true })
    assert.equal(run(), '')
    fs.writeFileSync(path.join(folder, 'pending'), '')
    assert.equal(run(), 'RAN')
  })
})

describe('reading git\'s own arguments', () => {
  it('finds the message wherever git takes it from, and leaves forms that reuse one', () => {
    assert.deepEqual(parseCommitArgs(['-am', 'msg']).messages, [{ index: 1, prefix: '', value: 'msg' }])
    assert.deepEqual(parseCommitArgs(['-amsg']).messages, [{ index: 0, prefix: '-am', value: 'sg' }])
    assert.deepEqual(parseCommitArgs(['--message=msg']).messages, [{ index: 0, prefix: '--message=', value: 'msg' }])
    assert.deepEqual(parseCommitArgs(['-q', '-F', '-']).files, [{ index: 2, prefix: '', value: '-' }])
    assert.equal(parseCommitArgs(['--amend', '-m', 'x']).reusing, true)
    assert.equal(parseCommitArgs(['--fixup=HEAD']).reusing, true)
    assert.equal(parseCommitArgs(['-C', 'HEAD']).reusing, true)
    assert.equal(parseCommitArgs(['--no-such-option', '-m', 'x']), null)
    assert.equal(tagSubject('\n\nSubject\n\nBody', TASK_A), `\n\nSubject [devspec:${TASK_A}]\n\nBody`)
    assert.equal(tagSubject('   \n', TASK_A), null)
  })

  it('compares repositories by host, owner and name, whatever the URL form', () => {
    for (const form of ['git@github.com:Acme/App.git', 'https://github.com/acme/app', 'ssh://git@github.com/acme/app.git/']) {
      assert.equal(normalizeRemoteKey(form), 'github.com/acme/app')
    }
    assert.equal(normalizeRemoteKey('/local/path.git'), null)
  })
})
