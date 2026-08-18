import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')

describe('README command availability', () => {
  it('lists every currently contributed DevSpec command title', () => {
    const titles = packageJson.contributes.commands.map((command) => command.title)
    for (const title of titles) assert.match(readme, new RegExp(`\\| ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`))
  })

  it('does not advertise removed skill commands', () => {
    for (const removed of [
      'DevSpec: Work on action item',
      'DevSpec: Brainstorm action item',
      'DevSpec: Create action item',
      'DevSpec: Verify connection',
    ]) {
      assert.equal(readme.includes(`| ${removed} |`), false, removed)
    }
  })
})
