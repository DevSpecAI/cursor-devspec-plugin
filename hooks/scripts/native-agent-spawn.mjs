/** Cursor-owned native CLI invocation for project-choice commands.
 * This does not install a launcher, register a protocol or start a service. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
function quote(value) {
  const text = String(value)
  if (!text) return '""'
  return /[\s"&<>|^()]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
export function nativeInvocation(executable, { platform = process.platform, exists = fs.existsSync, systemRoot = process.env.SystemRoot } = {}) {
  if (platform !== 'win32') return { command: executable, args: [], shell: false }
  const candidates = /\.ps1$/i.test(executable) ? [executable]
    : /\.(cmd|bat)$/i.test(executable) ? [executable.replace(/\.(cmd|bat)$/i, '.ps1')] : []
  for (const file of candidates) if (exists(file)) return {
    command: systemRoot ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe',
    args: ['-NoProfile', '-File', file], shell: false,
  }
  return { command: executable, args: [], shell: !/\.exe$/i.test(executable) }
}
export function spawnAgentSync(executable, args, options) {
  const invocation = nativeInvocation(executable)
  if (!invocation.shell) return spawnSync(invocation.command, [...invocation.args, ...args], { ...options, shell: false, windowsHide: true })
  // Only the Windows batch-shim fallback needs cmd; preserve literal argument boundaries.
  const line = [executable, ...args].map(quote).join(' ')
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsHide: true, windowsVerbatimArguments: true })
}
