import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildLinuxDesktopEntry,
  linuxDesktopExecLine,
  mimeappsCandidatePaths,
  quoteDesktopExecArg,
  stripConflictingSchemeAssociations,
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

/*
 * Recovering from a wrong "open with…" choice. Reported live on Ubuntu/KDE: the
 * first devspec:// link raised a KDE chooser that offered only "Cursor Agents",
 * and once picked, every launch went there and the real handler was never
 * invoked. Registering our own default does not undo that on its own — a
 * desktop-specific mimeapps.list outranks it, and a Removed Associations entry
 * blocks us outright.
 */
describe('scheme association repair', () => {
  const OURS = 'devspec-protocol.desktop'

  it('drops another app that holds the scheme as default', () => {
    const { contents, changed } = stripConflictingSchemeAssociations(
      '[Default Applications]\nx-scheme-handler/devspec=cursor-agents.desktop;\ntext/html=firefox.desktop;\n',
    )
    assert.equal(changed, true)
    assert.doesNotMatch(contents, /cursor-agents/)
    assert.match(contents, /text\/html=firefox\.desktop;/)
  })

  it('keeps our handler and removes only the competing ones', () => {
    const { contents, changed } = stripConflictingSchemeAssociations(
      `[Added Associations]\nx-scheme-handler/devspec=cursor-agents.desktop;${OURS};other.desktop;\n`,
    )
    assert.equal(changed, true)
    assert.match(contents, new RegExp(`x-scheme-handler/devspec=${OURS.replace('.', '\\.')};`))
    assert.doesNotMatch(contents, /cursor-agents|other\.desktop/)
  })

  it('unblocks a handler listed under Removed Associations', () => {
    const { contents, changed } = stripConflictingSchemeAssociations(
      `[Removed Associations]\nx-scheme-handler/devspec=${OURS};\n`,
    )
    assert.equal(changed, true)
    assert.doesNotMatch(contents, /devspec-protocol\.desktop/)
  })

  it('leaves a file that already names only us untouched', () => {
    const input = `[Default Applications]\nx-scheme-handler/devspec=${OURS};\n`
    const { contents, changed } = stripConflictingSchemeAssociations(input)
    assert.equal(changed, false)
    assert.equal(contents, input)
  })

  it('never touches another scheme or a commented line', () => {
    const input =
      '[Default Applications]\n#x-scheme-handler/devspec=old.desktop;\nx-scheme-handler/cursor=cursor.desktop;\n'
    const { contents, changed } = stripConflictingSchemeAssociations(input)
    assert.equal(changed, false)
    assert.equal(contents, input)
  })

  it('checks the desktop-specific mimeapps.list BEFORE the plain one', () => {
    const paths = mimeappsCandidatePaths(
      { XDG_CURRENT_DESKTOP: 'KDE', XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d' },
      '/home/u',
    )
    assert.equal(paths[0], '/c/kde-mimeapps.list')
    assert.equal(paths[1], '/c/mimeapps.list')
    assert.ok(paths.includes('/d/applications/mimeapps.list'))
  })

  it('handles a multi-desktop XDG_CURRENT_DESKTOP', () => {
    const paths = mimeappsCandidatePaths(
      { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d' },
      '/home/u',
    )
    assert.equal(paths[0], '/c/ubuntu-mimeapps.list')
    assert.equal(paths[1], '/c/gnome-mimeapps.list')
  })
})
