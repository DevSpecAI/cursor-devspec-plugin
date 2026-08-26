import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { buildPostLiveRemoteBrief } from './pin-remote-plugin.mjs'

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const pluginJson = JSON.parse(read('.cursor-plugin/plugin.json'))
const mcp = JSON.parse(read('mcp.json'))
const readme = read('README.md')
const changelog = read('CHANGELOG.md')
const remoteSkill = read('skills/devspec.remote/SKILL.md')

describe('Cursor shared-session-plan surfaces', () => {
  it('keeps the command surface Cursor-operational and does not revive a prose work command', () => {
    const commandIds = packageJson.contributes.commands.map((command) => command.command)
    assert.deepEqual(commandIds.filter((id) => /^devspec\.(remote|remote-stop)$/.test(id)), [
      'devspec.remote', 'devspec.remote-stop',
    ])
    assert.equal(commandIds.includes('devspec.work'), false)
    assert.equal(commandIds.includes('devspec.managePlan'), false)
  })

  it('keeps global MCP config generic: no per-conversation secret or giant static schema', () => {
    const serialized = JSON.stringify(mcp)
    assert.match(serialized, /DEVSPEC_MCP_TOKEN/)
    assert.doesNotMatch(serialized, /capability|manage_plan|expected_revision|directTools/i)
  })

  it('documents the independent Cursor release and protected publish-time package bump', () => {
    assert.equal(pluginJson.version, '0.11.1')
    assert.match(changelog, /^# Changelog\s+## 0\.11\.1/m)
    assert.match(changelog, /Cursor releases are versioned independently/i)
    assert.match(changelog, /package\.json.*protected.*0\.8\.0/is)
    assert.match(readme, /Shared session plans during remote control/)
    assert.match(readme, /manual chat without that id.*exactly one live, attached/i)
    assert.match(readme, /Ambiguous sibling connections fail closed/i)
  })

  it('keeps plan schema on demand and bounds prompt bytes before/after plan guidance', () => {
    const brief = buildPostLiveRemoteBrief({
      pluginPath: '/cursor/devspec-autopilot',
      connectionId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      codename: 'Calm Fox',
      localId: 'cursor-chat-a',
    })
    const afterBytes = Buffer.byteLength(brief)
    const beforePlanLines = brief.split('\n').filter((line) =>
      !line.includes('**Active plans:**') &&
      !line.includes('Cursor plan mutations use the connection-bound helper only:'),
    ).join('\n')
    const beforeBytes = Buffer.byteLength(beforePlanLines)
    assert.ok(afterBytes > beforeBytes)
    assert.ok(afterBytes - beforeBytes < 1_600, `plan guidance delta ${afterBytes - beforeBytes} bytes`)
    assert.ok(afterBytes < 8_000, `thin post-Live brief ${afterBytes} bytes`)
    assert.match(brief, /manage-plan describe/)
    assert.doesNotMatch(brief, /"current_step_id"|"next_step_id"|"retryable"/)
    assert.match(remoteSkill, /complete schema.*on demand|bounded on-demand discovery/i)
  })

  it('preserves Cursor-native resume and local-session documentation', () => {
    assert.match(readme, /agent --resume/)
    assert.match(readme, /local_session_id/)
    assert.match(changelog, /native `agent --resume`.*`local_session_id` behavior is unchanged/s)
  })
})
