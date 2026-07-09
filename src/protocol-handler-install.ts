import * as vscode from 'vscode'
import { spawn } from 'child_process'
import * as path from 'path'

/**
 * Install the devspec:// protocol handler (Windows/Linux) or macOS localhost bridge.
 * Runs outside the extension host so browser handoffs work in Glass layout.
 */
export function installProtocolHandler(extensionPath: string): void {
  const handlerScript = path.join(extensionPath, 'scripts', 'open-handler.mjs')
  const child = spawn('node', [handlerScript, '--install'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  child.unref()
}

export function registerProtocolHandlerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devspec.installProtocolHandler', async () => {
      installProtocolHandler(context.extensionPath)
      const message =
        process.platform === 'darwin'
          ? 'DevSpec: macOS localhost bridge started. "Open in Cursor" from the DevSpec web app should work after you reload the page.'
          : 'DevSpec: devspec:// protocol handler installed. Click the rocket on devspec.ai and allow the browser prompt on first use.'
      void vscode.window.showInformationMessage(message)
    }),
    vscode.commands.registerCommand('devspec.installOpenBridge', async () => {
      installProtocolHandler(context.extensionPath)
      void vscode.window.showInformationMessage(
        'DevSpec: handoff handler installed (devspec:// on Windows/Linux, localhost bridge on macOS).',
      )
    }),
    vscode.commands.registerCommand('devspec.startOpenBridge', async () => {
      installProtocolHandler(context.extensionPath)
      void vscode.window.showInformationMessage('DevSpec: handoff handler install requested.')
    }),
  )
}
