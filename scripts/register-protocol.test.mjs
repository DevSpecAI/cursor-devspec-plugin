import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildLinuxDesktopEntry,
  linuxDesktopExecLine,
  quoteDesktopExecArg,
} from './register-protocol.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

/*
 * These guard the two defects that made every devspec:// launch on Linux fail
 * silently: the Exec line pointed at devspec-handler.cmd (a cmd.exe batch file
 * — `sh: @echo: not found`) and carried no %u, so the handler never received a
 * URL. Neither is visible without asserting on the generated entry, which is
 * why the bug survived for as long as it did.
 */
describe('linux desktop Exec line', () => {
  const LAUNCHER = '/home/u/.cursor/devspec/devspec-handler.sh'

  it('execs the POSIX launcher, never the Windows batch file', () => {
    const line = linuxDesktopExecLine({ launcherPath: LAUNCHER })
    assert.match(line, /devspec-handler\.sh/)
    assert.doesNotMatch(line, /\.cmd/)
    assert.doesNotMatch(line, /\.vbs/)
  })

  it('always passes the URL through as an unquoted %u field code', () => {
    for (const line of [
      linuxDesktopExecLine({ launcherPath: LAUNCHER }),
      linuxDesktopExecLine({ nodeBin: 'node', handlerPath: '/h/open-handler.mjs' }),
    ]) {
      assert.ok(line.endsWith(' %u'), `missing %u: ${line}`)
      assert.doesNotMatch(line, /"%u"/)
    }
  })

  it('falls back to node + handler when no launcher is installed', () => {
    const line = linuxDesktopExecLine({
      launcherPath: null,
      nodeBin: '/usr/bin/node',
      handlerPath: '/home/u/.cursor/devspec/open-handler.mjs',
    })
    assert.equal(line, '"/usr/bin/node" "/home/u/.cursor/devspec/open-handler.mjs" %u')
  })

  it('quotes paths so a home directory with spaces still launches', () => {
    const line = linuxDesktopExecLine({ launcherPath: '/home/a b/devspec-handler.sh' })
    assert.equal(line, '"/home/a b/devspec-handler.sh" %u')
  })

  it('escapes the characters that stay special inside desktop-entry quotes', () => {
    assert.equal(quoteDesktopExecArg('/tmp/a"b'), '"/tmp/a\\"b"')
    assert.equal(quoteDesktopExecArg('/tmp/a$b'), '"/tmp/a\\$b"')
    assert.equal(quoteDesktopExecArg('/tmp/a\\b'), '"/tmp/a\\\\b"')
    assert.equal(quoteDesktopExecArg('/tmp/a`b'), '"/tmp/a\\`b"')
  })
})

describe('linux desktop entry', () => {
  const entry = buildLinuxDesktopEntry('"/x/devspec-handler.sh" %u')

  it('claims the devspec scheme', () => {
    assert.match(entry, /^\[Desktop Entry\]$/m)
    assert.match(entry, /^MimeType=x-scheme-handler\/devspec;$/m)
    assert.match(entry, /^Type=Application$/m)
  })

  it('leaves the terminal to the handler and stays out of app menus', () => {
    // open-handler-core spawns its own emulator for CLI launches; Terminal=true
    // would nest a second window around it.
    assert.match(entry, /^Terminal=false$/m)
    assert.match(entry, /^NoDisplay=true$/m)
  })

  it('ends the Exec line with %u', () => {
    const exec = entry.split('\n').find((l) => l.startsWith('Exec='))
    assert.ok(exec?.endsWith(' %u'), `bad Exec: ${exec}`)
  })
})

describe('devspec-handler.sh', () => {
  const launcher = path.join(SCRIPTS_DIR, 'devspec-handler.sh')

  it('is shipped, executable and passes the URL to the handler', () => {
    const stat = fs.statSync(launcher)
    assert.ok(stat.mode & 0o111, 'launcher must be executable')
    const body = fs.readFileSync(launcher, 'utf8')
    assert.match(body, /^#!\/bin\/sh$/m)
    assert.match(body, /exec "\$NODE" "\$HANDLER" --url "\$URL"/)
  })

  it('is copied by --install so the Exec target exists', () => {
    const installer = fs.readFileSync(path.join(SCRIPTS_DIR, 'open-handler.mjs'), 'utf8')
    assert.match(installer, /'devspec-handler\.sh',/)
  })
})
