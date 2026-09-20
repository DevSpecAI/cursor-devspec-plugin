import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { buildPostLiveRemoteBrief } from './pin-remote-plugin.mjs'

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const pluginJson = JSON.parse(read('.cursor-plugin/plugin.json'))
const marketplaceJson = JSON.parse(read('.cursor-plugin/marketplace.json'))
const mcp = JSON.parse(read('mcp.json'))
const readme = read('README.md')
const changelog = read('CHANGELOG.md')
const remoteSkill = read('skills/devspec.remote/SKILL.md')

describe('Cursor shared-session-plan surfaces', () => {
  it('keeps the command surface Cursor-operational and does not revive a prose work command', () => {
    // This used to read `contributes.commands` from the VS Code manifest. The IDE
    // extension is gone, so the surface a user actually reaches is the plugin's
    // skills directory — the assertion is the same one, against where it now lives.
    const skills = fs.readdirSync(new URL('../skills', import.meta.url)).sort()
    assert.deepEqual(skills, ['devspec.remote', 'devspec.remote-stop'])
    assert.equal(skills.includes('devspec.work'), false)
    assert.equal(skills.includes('devspec.managePlan'), false)
  })

  it('ships no VS Code extension surface — Cursor is CLI-only', () => {
    // The VSIX is not "unused", it is gone: a manifest that still declares an
    // activation point is an install path someone will follow (item 19956e89).
    for (const field of ['main', 'contributes', 'activationEvents', 'engines', 'publisher']) {
      assert.equal(field in packageJson, false, `package.json still declares ${field}`)
    }
    assert.equal(fs.existsSync(new URL('../src/extension.ts', import.meta.url)), false)
    assert.equal(fs.existsSync(new URL('../tsconfig.json', import.meta.url)), false)
    assert.doesNotMatch(JSON.stringify(packageJson.scripts), /vsce|esbuild/)
  })

  it('documents the marketplace install and never the VSIX one', () => {
    // The README is the install path for anyone who did not read the code, so a
    // stale instruction here is not cosmetic — it is a route people follow.
    assert.match(readme, /cursor-agent plugin marketplace add/)
    assert.match(readme, /Adding a marketplace does not install the plugin/)
    assert.doesNotMatch(readme, /Install from VSIX/i)
    assert.doesNotMatch(readme, /command palette/i)
    assert.doesNotMatch(readme, /DevSpec: (Set MCP token|Install rules|Install agent hooks)/)
  })

  it('never hands the reader `marketplace update` as the way to update', () => {
    // `cursor-agent plugin marketplace update` reports success and fetches nothing:
    // add resolves the ref to a SHA and discards the branch name, so there is
    // nothing to re-resolve (item 9d44f370). This README shipped that instruction
    // for a few hours. The guard is placement, not mention — the command may be
    // NAMED in the explanation of why not to use it, but must never appear inside
    // a fenced block, which is where a reader copies from.
    const fenced = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
    for (const block of fenced) {
      assert.doesNotMatch(block, /marketplace update/, `a copyable block tells the reader to run marketplace update:\n${block}`)
    }
    assert.match(readme, /marketplace remove/)
  })

  it('keeps global MCP config generic: no per-conversation secret or giant static schema', () => {
    const serialized = JSON.stringify(mcp)
    assert.match(serialized, /DEVSPEC_MCP_TOKEN/)
    assert.doesNotMatch(serialized, /capability|manage_plan|expected_revision|directTools/i)
  })

  it('documents the independent Cursor release and protected publish-time package bump', () => {
    // Assert the RELATIONSHIP, not the number of the day: the manifest ships the
    // same version as the package (the 0.13.0 release made that true), and the
    // changelog's newest heading is that version. Pinning a literal here made the
    // suite go red on every release instead of on a real mistake, and it did.
    assert.equal(pluginJson.version, packageJson.version)
    // The marketplace manifest is what makes the plugin installable at all, and it
    // carries its own copy of the version. A third place to drift is a third place
    // to ship a stale one, so it is asserted here rather than trusted.
    assert.equal(marketplaceJson.plugins.length, 1)
    assert.equal(marketplaceJson.plugins[0].version, packageJson.version)
    assert.equal(marketplaceJson.plugins[0].name, pluginJson.name)
    assert.match(changelog, new RegExp(`^# Changelog\\s+## ${packageJson.version.replace(/\./g, '\\.')}\\b`, 'm'))
    assert.match(changelog, /Cursor releases are versioned independently/i)
    assert.match(changelog, /package\.json.*protected.*0\.8\.0/is)
    assert.match(readme, /Shared session plans during remote control/)
    assert.match(readme, /manual chat without that id.*exactly one live, attached/i)
    assert.match(readme, /Ambiguous sibling connections fail closed/i)
  })

  it('declares in the manifest every variable mcp.json references', () => {
    // Cursor's marketplace submission checklist rejects a plugin whose mcp.json uses a
    // ${VAR} the manifest's variables schema does not declare — and the declaration is
    // also the customer experience: declared variables are prompted at install and
    // editable under Plugins → Configure, instead of a hand-edited file (item f67ff2e9).
    const variables = pluginJson.variables
    assert.ok(variables, 'plugin.json declares no variables schema')
    assert.equal(variables.type, 'object')
    assert.ok(variables.properties && typeof variables.properties === 'object')
    const referenced = [...JSON.stringify(mcp).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1])
    assert.ok(referenced.length > 0, 'mcp.json references no variables — is the placeholder gone?')
    for (const name of referenced) {
      assert.ok(name in variables.properties, `mcp.json references \${${name}} but the manifest does not declare it`)
    }
    // Only Cursor's accepted schema subset — anything else fails their parser, not ours.
    const allowed = new Set(['type', 'title', 'description', 'default', 'enum', 'const', 'items', 'required', 'properties',
      'minLength', 'maxLength', 'pattern', 'minimum', 'maximum'])
    for (const [name, schema] of Object.entries(variables.properties)) {
      for (const key of Object.keys(schema)) {
        assert.ok(allowed.has(key), `variables.${name} uses unsupported schema keyword "${key}"`)
      }
    }
    // The token is the one the customer must supply; the API URL is our staging override
    // and must stay optional with the production default — never required, never staging.
    assert.ok(variables.required.includes('DEVSPEC_MCP_TOKEN'))
    assert.ok(!variables.required.includes('DEVSPEC_API_URL'))
    assert.equal(variables.properties.DEVSPEC_API_URL.default, 'https://api.devspec.ai')
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

  it('every capability-bound bridge is discoverable from the brief a Connect launch loads', () => {
    // A Connect launch reads this brief, NOT the 44KB SKILL.md. Directed questions
    // shipped with their guidance only in the skill, so a Cursor agent could be woken
    // by an answer but had no way to learn it could ask (item b9f2c77a, round 2). Any
    // future connection-bound bridge has the same requirement: name it here or it does
    // not exist as far as a Connect agent is concerned. Schemas stay on demand.
    const brief = buildPostLiveRemoteBrief({
      pluginPath: '/cursor/devspec-autopilot',
      connectionId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      codename: 'Calm Fox',
      localId: 'cursor-chat-a',
    })
    for (const bridge of ['manage-plan describe', 'manage-question describe', 'manage-question respond']) {
      assert.match(brief, new RegExp(bridge.replace(' ', '\\s')), `${bridge} must be reachable from the brief`)
    }
    // Discovery, not the schema: the brief names the command and nothing more.
    assert.doesNotMatch(brief, /"client_request_id"|"response_kind"|"allow_custom"/)
    assert.ok(Buffer.byteLength(brief) < 8_000, `thin post-Live brief ${Buffer.byteLength(brief)} bytes`)
  })

  it('preserves Cursor-native resume and local-session documentation', () => {
    assert.match(readme, /agent --resume/)
    assert.match(readme, /local_session_id/)
    assert.match(changelog, /native `agent --resume`.*`local_session_id` behavior is unchanged/s)
  })
})
