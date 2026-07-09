import * as vscode from 'vscode'
import { spawn } from 'child_process'
import * as path from 'path'

/**
 * Install and start the standalone open bridge (~/.cursor/devspec/ + login startup).
 * Required for DevSpec "Open in Cursor" from the browser — Cursor Glass layout does
 * not load user VSIX extensions, so the bridge runs outside the extension host.
 */
export function installAndStartOpenBridge(extensionPath: string): void {
  const bridgeScript = path.join(extensionPath, 'scripts', 'open-bridge.mjs')
  const child = spawn('node', [bridgeScript, '--install', '--force'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  child.unref()
}

export function registerOpenBridgeCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devspec.installOpenBridge', async () => {
      installAndStartOpenBridge(context.extensionPath)
      void vscode.window.showInformationMessage(
        'DevSpec: open bridge installed and started. "Open in Cursor" from the DevSpec web app should work after you reload this page.',
      )
    }),
    vscode.commands.registerCommand('devspec.startOpenBridge', async () => {
      installAndStartOpenBridge(context.extensionPath)
      void vscode.window.showInformationMessage(
        'DevSpec: open bridge start requested.',
      )
    }),
  )
}
