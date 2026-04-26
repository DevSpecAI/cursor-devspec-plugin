# DevSpec Autopilot for Cursor

Cursor extension that connects Cursor's AI agent to the [DevSpec](https://devspec.ai) project management platform via MCP. Pick up queued action items, brainstorm scope, run autopilot, and ship work without leaving the editor.

This is the Cursor counterpart to the [Claude Code](https://github.com/DevSpecAI/claude-code-devspec-autopilot) and [Gemini CLI](https://github.com/DevSpecAI/gemini-cli-devspec-autopilot-extension) autopilot extensions.

## What it does

The extension does two things:

1. **Auto-registers a DevSpec MCP server** in `~/.cursor/mcp.json` so Cursor's chat agent can call DevSpec tools (list action items, claim work, generate commit messages, link commits, etc.).
2. **Adds five DevSpec commands** to Cursor's command palette. Each loads a curated SKILL.md prompt, optionally prompts for input (e.g. an action item title), and copies the combined prompt to the clipboard so you can paste it into Cursor chat.

| Command | Purpose |
|---|---|
| `DevSpec: Work on action item` | Pick up a specific item by name or ID, optional brainstorm, implement, push, report. |
| `DevSpec: Brainstorm action item` | Multi-round Q&A to explore scope, approach, edge cases, acceptance criteria. |
| `DevSpec Autopilot: Process next queued item` | Fully autonomous: claim the next queued item, implement, test, commit, push, merge, report. |
| `DevSpec Autopilot: Show status` | Queue counts, in-progress items, push/merge settings, runner state. |
| `DevSpec Autopilot: Show history` | Recent autopilot runs — completed and failed items, branches, merge status. |

Commits include a `[devspec:<id>]` tag so DevSpec's deployment webhook can link successful deploys back to the action item.

## Installation

### From VSIX (recommended for clients today)

1. Download the latest `devspec-autopilot.vsix` from the [Releases](https://github.com/DevSpecAI/cursor-devspec-plugin/releases) page.
2. In Cursor: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → select the file.
3. After install, run the command **`DevSpec: Set MCP token`** and paste a token generated in your DevSpec project's **Settings → Integrations** page.
4. Restart Cursor so the new MCP server is loaded.

### From source

```bash
git clone https://github.com/DevSpecAI/cursor-devspec-plugin.git
cd cursor-devspec-plugin
npm install
npm run package      # produces devspec-autopilot.vsix
```

Then install the VSIX as above.

## Configuration

Settings (Cursor: `File → Preferences → Settings`, search "DevSpec"):

| Setting | Default | Notes |
|---|---|---|
| `devspec.apiUrl` | `https://app.devspec.ai` | Use `https://staging.devspec.ai` for staging. |
| `devspec.mcpToken` | _(empty)_ | DevSpec MCP token. Per-machine, never synced. |

When the token changes, the extension rewrites `~/.cursor/mcp.json` to point Cursor at the configured `apiUrl`. You can re-trigger registration any time with **`DevSpec: Register MCP server in Cursor config`**.

## Usage

After install, open the command palette (`Ctrl+Shift+P`) and start typing "DevSpec". Each skill command:

1. Optionally prompts for an action item identifier.
2. Loads the curated SKILL.md instructions for that command.
3. Copies the combined prompt to your clipboard.
4. Tells you to paste into Cursor chat (`Ctrl+L`) to run.

This is the "v0.1" surface — clipboard copy/paste. Future versions will integrate directly with Cursor's chat agent so the skill kicks off automatically.

## License

MIT — see [LICENSE](./LICENSE).
