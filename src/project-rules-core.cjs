const { promises: fs } = require('node:fs')
const path = require('node:path')

/** A checkout may expose .git as a directory or as a gitdir pointer file. */
async function hasGitMetadata(root, stat = fs.stat) {
  try {
    const metadata = await stat(path.join(root, '.git'))
    return metadata.isDirectory() || metadata.isFile()
  } catch {
    return false
  }
}

module.exports = { hasGitMetadata }
