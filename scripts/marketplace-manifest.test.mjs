/**
 * Cursor's Marketplace submission checklist, checked against the files Cursor reads
 * (https://cursor.com/docs/reference/plugins#submission-checklist):
 *
 * - a valid `.cursor-plugin/plugin.json` with a unique, lowercase, kebab-case name;
 * - a logo committed to the repository and referenced by a relative path;
 * - every `${VAR}` in mcp.json declared in the manifest's variables schema;
 * - every path in the manifests relative and valid (no `..`, nothing absolute);
 * - every rule, skill and hook file valid, with the frontmatter Cursor requires;
 * - a marketplace manifest at the repository root with unique plugin names.
 *
 * These read the manifests as data and follow them to the files they name, so a
 * renamed plugin, a moved file or a new placeholder fails here before a reviewer
 * finds it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const root = fileURLToPath(new URL('..', import.meta.url))
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
const plugin = readJson('.cursor-plugin/plugin.json')
const marketplace = readJson('.cursor-plugin/marketplace.json')
const mcp = readJson('mcp.json')
const hooks = readJson('hooks/hooks.json')
const packageJson = readJson('package.json')

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Each string a manifest field holds, whether it is one path or a list of them. */
const paths = (value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [])

/** The relative-path rule from the checklist, and that the path names something in the repository. */
function assertRelativeExisting(value, field) {
  assert.equal(typeof value, 'string', `${field} is not a path`)
  assert.ok(value.length > 0, `${field} is empty`)
  assert.equal(value.includes('://'), false, `${field} is a URL, not a relative path: ${value}`)
  assert.equal(path.posix.isAbsolute(value) || path.win32.isAbsolute(value), false, `${field} is absolute: ${value}`)
  assert.equal(value.split(/[\\/]/).includes('..'), false, `${field} climbs out of the plugin: ${value}`)
  const resolved = path.resolve(root, value)
  assert.ok(resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep), `${field} leaves the repository: ${value}`)
  assert.ok(fs.existsSync(resolved), `${field} names a file that does not exist: ${value}`)
}

/**
 * The pixels of an 8-bit, non-interlaced PNG as RGBA rows. Enough of the format to
 * look at a logo without a dependency; anything else fails with what it found.
 */
function decodePng(file) {
  const buffer = fs.readFileSync(file)
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`)
  let offset = 8
  let header
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], interlace: body[12] }
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  assert.ok(header, 'the PNG has no header')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colour]
  assert.ok(channels && header.depth === 8 && header.interlace === 0,
    `unsupported PNG layout (colour type ${header.colour}, depth ${header.depth}, interlace ${header.interlace}); save the logo as 8-bit RGBA`)
  const raw = inflateSync(Buffer.concat(data))
  const stride = header.width * channels
  const pixels = Buffer.alloc(header.height * stride)
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0
      let value = raw[y * (stride + 1) + 1 + x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
        value += a <= b && a <= c ? left : b <= c ? up : upLeft
      } else assert.equal(filter, 0, `unknown PNG row filter ${filter}`)
      pixels[y * stride + x] = value & 0xff
    }
  }
  const alpha = (x, y) => (channels === 4 ? pixels[y * stride + x * 4 + 3] : channels === 2 ? pixels[y * stride + x * 2 + 1] : 255)
  return { ...header, alpha }
}

/** The YAML frontmatter of a rule or skill as flat key/value strings. */
function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  assert.ok(match, `${path.relative(root, file)} has no frontmatter`)
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (field) fields[field[1]] = field[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return fields
}

describe('Cursor Marketplace submission checklist', () => {
  it('names the plugin once, in kebab-case, the same in every manifest', () => {
    assert.match(plugin.name, KEBAB, 'plugin.json name must be lowercase kebab-case')
    assert.match(marketplace.name, KEBAB, 'marketplace.json name must be lowercase kebab-case')
    assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'marketplace.json lists no plugins')
    const names = marketplace.plugins.map((entry) => entry.name)
    assert.equal(new Set(names).size, names.length, 'marketplace plugin names must be unique')
    for (const name of names) assert.match(name, KEBAB)
    assert.deepEqual(names, [plugin.name])
    assert.equal(packageJson.name, plugin.name)
    assert.equal(typeof marketplace.owner?.name, 'string', 'marketplace.json needs an owner name')
    assert.ok(typeof plugin.description === 'string' && plugin.description.trim(), 'plugin.json needs a description')
  })

  it('uses only manifest fields Cursor documents', () => {
    // The reference's required and optional fields, plus displayName, which Cursor's own
    // manifest parser reads for the name it shows.
    const known = new Set(['name', 'displayName', 'description', 'version', 'author', 'homepage', 'repository', 'license',
      'keywords', 'logo', 'rules', 'agents', 'skills', 'commands', 'hooks', 'mcpServers', 'variables'])
    for (const key of Object.keys(plugin)) assert.ok(known.has(key), `plugin.json has a field Cursor does not document: ${key}`)
    assert.equal(typeof plugin.author?.name, 'string', 'author.name is required when author is given')
  })

  it('keeps every manifest path relative and pointing at a file in the repository', () => {
    const fields = ['logo', 'rules', 'agents', 'skills', 'commands', 'hooks', 'mcpServers']
    for (const field of fields) for (const value of paths(plugin[field])) assertRelativeExisting(value, `plugin.json ${field}`)
    if (marketplace.metadata?.pluginRoot !== undefined) assertRelativeExisting(marketplace.metadata.pluginRoot, 'marketplace.json metadata.pluginRoot')
    for (const entry of marketplace.plugins) {
      const source = typeof entry.source === 'string' ? entry.source : entry.source?.path
      assertRelativeExisting(source, `marketplace.json ${entry.name} source`)
      const pluginRoot = path.join(marketplace.metadata?.pluginRoot ?? '', source)
      assert.ok(fs.existsSync(path.join(root, pluginRoot, '.cursor-plugin/plugin.json')), `${entry.name} source has no .cursor-plugin/plugin.json`)
      for (const field of fields) for (const value of paths(entry[field])) assertRelativeExisting(value, `marketplace.json ${entry.name} ${field}`)
    }
  })

  it('ships a square logo with a solid plate behind the mark', () => {
    assert.ok(plugin.logo, 'plugin.json has no logo')
    assertRelativeExisting(plugin.logo, 'plugin.json logo')
    const logo = decodePng(path.join(root, plugin.logo))
    assert.equal(logo.width, logo.height, `the logo is ${logo.width}×${logo.height}, not square`)
    const middle = Math.floor(logo.width / 2)
    // A transparent logo disappears on Cursor's dark theme: the centre must be opaque, and
    // the plate must run edge to edge through it (only rounded corners may be see-through).
    assert.equal(logo.alpha(middle, middle), 255, 'the centre of the logo is transparent')
    for (let i = 0; i < logo.width; i++) {
      assert.equal(logo.alpha(i, middle), 255, `the logo's middle row is transparent at x=${i}`)
      assert.equal(logo.alpha(middle, i), 255, `the logo's middle column is transparent at y=${i}`)
    }
  })

  it('declares every variable mcp.json uses, read the way Cursor substitutes them', () => {
    // Cursor's substitution grammar: ${NAME}, ${NAME:-default} and ${env:NAME}. Its own
    // plugin-root variables are filled in by Cursor, never by the person installing.
    const grammar = /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|([^:}]+)(?::-([^}]*))?)\}/g
    const builtIn = new Set(['CURSOR_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'])
    const used = new Set()
    const walk = (value) => {
      if (typeof value === 'string') for (const match of value.matchAll(grammar)) used.add(match[1] ?? match[2])
      else if (value && typeof value === 'object') Object.values(value).forEach(walk)
    }
    walk(mcp)
    for (const name of builtIn) used.delete(name)
    assert.ok(used.size > 0, 'mcp.json uses no variables; is the token placeholder gone?')
    assert.equal(plugin.variables?.type, 'object')
    const declared = plugin.variables.properties ?? {}
    for (const name of used) assert.ok(Object.hasOwn(declared, name), `mcp.json uses \${${name}} but plugin.json does not declare it`)
    for (const name of plugin.variables.required ?? []) assert.ok(Object.hasOwn(declared, name), `${name} is required but not declared`)
    for (const [name, schema] of Object.entries(declared)) {
      assert.ok(used.has(name), `plugin.json declares ${name}, which mcp.json never uses`)
      assert.ok(schema.title && schema.description, `${name} needs a title and description: the person installing reads them`)
    }
  })

  it('gives every rule the frontmatter Cursor requires', () => {
    const rules = fs.readdirSync(path.join(root, 'rules')).filter((name) => /\.(mdc|md|markdown)$/.test(name))
    assert.ok(rules.length > 0)
    for (const name of rules) {
      const fields = frontmatter(path.join(root, 'rules', name))
      assert.ok(fields.description, `rules/${name} needs a description`)
      assert.ok(['true', 'false'].includes(fields.alwaysApply) || fields.globs, `rules/${name} needs alwaysApply (true or false) or globs`)
    }
  })

  it('gives every skill a name of lowercase letters, numbers and hyphens, matching its folder, and a description', () => {
    const skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    assert.ok(skills.length > 0)
    for (const skill of skills) {
      const file = path.join(root, 'skills', skill.name, 'SKILL.md')
      assert.ok(fs.existsSync(file), `skills/${skill.name} has no SKILL.md`)
      const fields = frontmatter(file)
      // Cursor's skills page: lowercase letters, numbers and hyphens only, matching the folder.
      assert.match(fields.name ?? '', KEBAB, `skills/${skill.name}: the name may use only lowercase letters, numbers and hyphens`)
      assert.equal(fields.name, skill.name, `skills/${skill.name}/SKILL.md names a different skill`)
      assert.ok(fields.description, `skills/${skill.name} needs a description`)
    }
  })

  it('wires every hook to a documented event and a script that exists', () => {
    const events = new Set(['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'subagentStart',
      'subagentStop', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile',
      'afterFileEdit', 'beforeSubmitPrompt', 'preCompact', 'stop', 'afterAgentResponse', 'afterAgentThought', 'beforeTabFileRead',
      'afterTabFileEdit', 'workspaceOpen'])
    assert.equal(hooks.version, 1)
    assert.ok(hooks.hooks && Object.keys(hooks.hooks).length > 0)
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      assert.ok(events.has(event), `hooks.json uses an event Cursor does not document: ${event}`)
      assert.ok(Array.isArray(entries) && entries.length > 0, `${event} has no hooks`)
      for (const entry of entries) {
        assert.equal(entry.type, 'command', `${event}: only command hooks are used`)
        assert.ok(typeof entry.command === 'string' && entry.command.trim(), `${event}: a hook has no command`)
        if (entry.matcher !== undefined) assert.doesNotThrow(() => new RegExp(entry.matcher), `${event}: matcher is not a regular expression`)
        if (entry.timeout !== undefined) assert.ok(Number.isFinite(entry.timeout) && entry.timeout > 0, `${event}: timeout must be a positive number`)
        for (const match of entry.command.matchAll(/\$\{(?:CLAUDE|CURSOR)_PLUGIN_ROOT\}\/([^"'\s]+)/g)) {
          assertRelativeExisting(match[1], `${event} hook script`)
        }
      }
    }
  })
})

describe('one release version everywhere it is written', () => {
  // A release bump touches every file below by hand, and a missed one ships a plugin
  // that names two versions: the Marketplace listing, the version DevSpec is told on
  // each request, and the header the install page asks people to keep can disagree.
  it('names the manifest version in the marketplace, package, lockfile, server header and install page', () => {
    const version = plugin.version
    const lock = readJson('package-lock.json')
    const entry = marketplace.plugins.find((p) => p.name === plugin.name)
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    const readmeHeaders = [...readme.matchAll(/"x-devspec-plugin":\s*"cursor\/([^"]+)"/g)].map((m) => m[1])
    assert.equal(entry?.version, version, 'marketplace.json')
    assert.equal(packageJson.version, version, 'package.json')
    assert.equal(lock.version, version, 'package-lock.json')
    assert.equal(lock.packages?.['']?.version, version, 'package-lock.json packages[""]')
    for (const [name, server] of Object.entries(mcp.mcpServers)) {
      assert.equal(server.headers?.['x-devspec-plugin'], `cursor/${version}`, `mcp.json ${name}`)
    }
    assert.ok(readmeHeaders.length > 0, 'the install page shows no x-devspec-plugin header to keep')
    for (const named of readmeHeaders) assert.equal(named, version, 'README.md install step')
  })
})
