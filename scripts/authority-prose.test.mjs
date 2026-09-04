import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'

const operationalFiles = [
  'skills/devspec.remote/SKILL.md',
  'docs/remote-control/remote-control-overview.md',
  'docs/remote-control/remote-control-cursor.md',
  'hooks/scripts/devspec-remote-poll.mjs',
  'hooks/scripts/devspec-remote-wait.mjs',
  'hooks/scripts/resolve-mcp-auth.mjs',
  'scripts/pin-remote-plugin.mjs',
]

const contents = new Map(
  operationalFiles.map((file) => [
    file,
    fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
  ]),
)

const primers = operationalFiles.slice(0, 3)

function assertInOrder(content, first, second, file) {
  const firstIndex = content.indexOf(first)
  const secondIndex = content.indexOf(second, firstIndex + first.length)
  assert.ok(firstIndex >= 0, `${file} must mention ${first}`)
  assert.ok(secondIndex > firstIndex, `${file} must teach ${first} before ${second}`)
}

describe('current Cursor authority and work-acquisition prose', () => {
  it('does not revive deleted assignment/progress delivery language', () => {
    const forbidden = [
      /\bget_connection_dispatch\b/i,
      /\breport_progress\b/i,
      /\bget_assignment\b/i,
      /\backnowledge_assignment\b/i,
      /\bresolve_assignment\b/i,
      /\bget_next_work_item\b/i,
      /\bdevspec\.work\b/i,
      /receives dispatches\s*\/\s*assignments/i,
      /receive dispatched work/i,
      /ready to be attached or dispatched work/i,
      /work arrives as a dispatch/i,
      /assignment\s*\/\s*`?report_progress`?/i,
      /owner dispatches to this connection/i,
      /\bdispatch delivery\b/i,
      /\blive assignment\b/i,
      /\bfirst dispatch after Connect\b/i,
      /\btargeted dispatches\b/i,
      /\bowner-only commands\b/i,
      /fail loudly, never silently, never by chatting/i,
      /fail a blocked item[^\n]*rather than stalling/i,
      /never do is post a question[^\n]*wait/i,
      /nobody may be there/i,
      /batch stalls dead/i,
      /server-delivered commands still win/i,
      /owner[^\n]{0,80}delegated[^\n]{0,80}identical capabilities/i,
      /delegat(?:ion|ed)[^\n]{0,80}changes? only who/i,
      /changes? who may command,? never what/i,
    ]

    for (const [file, content] of contents) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(content, pattern, `${file} contains stale operational prose: ${pattern}`)
      }
    }
  })

  it('points primers to served contracts and teaches reserve then claim', () => {
    for (const file of primers) {
      const content = contents.get(file)
      assert.match(content, /devspec:\/\/product\/remote-ingress-contract/, file)
      assert.match(content, /devspec:\/\/product\/implementation-contract/, file)
      assertInOrder(content, 'reserve_work_items', 'claim_work_item', file)
      assert.match(content, /nothing (?:is (?:ever )?sent work|sends action-item work)/i, file)
    }
  })

  it('keeps canonical authority, controls, and automations distinct', () => {
    for (const file of primers) {
      const content = contents.get(file)
      assert.match(content, /(?:exactly addressed|exact-target)/i, file)
      assert.match(content, /owner[\s\S]{0,80}delegated/i, file)
      assert.match(content, /immutable[\s\S]{0,80}requester[^\n]*provenance/i, file)
      assert.match(content, /project_scope|project scope/i, file)
      assert.match(content, /verbatim/i, file)
      assert.match(content, /devspec:\/\/product\/remote-ingress-contract/, file)
      assert.match(content, /typed[^\n]{0,80}control|control[^\n]{0,80}typed/i, file)
      assert.match(content, /owner-scoped[^\n]{0,80}`?automation_dispatch`?/i, file)
    }
  })

  it('keeps interaction policy item-scoped on every work surface', () => {
    for (const file of ['skills/devspec.remote/SKILL.md', 'scripts/pin-remote-plugin.mjs']) {
      const content = contents.get(file)
      assert.match(content, /multiple items do not change (?:that )?interaction policy/i, file)
      assert.match(content, /each claimed item[^\n]*served[^\n]*implementation(?:-| )contract/i, file)
      assert.match(content, /item(?:’s|'s)? intent[^\n]*(?:acceptance )?criteria/i, file)
    }
  })
})
