# DevSpec Autopilot for Cursor

Cursor extension that connects Cursor's AI agent to the [DevSpec](https://devspec.ai) project management platform via MCP. Pick up action items, brainstorm scope, run one-shot autopilot, and ship work without leaving the editor.

This is the Cursor counterpart to the [Claude Code](https://github.com/DevSpecAI/claude-code-devspec-autopilot) and [Gemini CLI](https://github.com/DevSpecAI/gemini-cli-devspec-autopilot-extension) autopilot extensions. Skill instructions are synced from the Claude plugin (source of truth) via `npm run sync`.

## What it does

The extension does two things:

1. **Auto-registers a DevSpec MCP server** in `~/.cursor/mcp.json` so Cursor's chat agent can call DevSpec tools (list action items, claim work, generate commit messages, link commits, etc.).
2. **Adds twelve DevSpec commands** to Cursor's command palette. Each loads a curated `SKILL.md` prompt (dot-named to match Claude), optionally prompts for input, and copies the combined prompt to the clipboard so you can paste it into Cursor chat.

### Work & planning

| Command | Skill | Purpose |
|---|---|---|
| `DevSpec: Work on action item` | `devspec.work` | Pick up a specific item, optional brainstorm, implement in worktree, push/merge, record. |
| `DevSpec: Brainstorm action item` | `devspec.brainstorm` | Multi-round Q&A to explore scope, approach, edge cases, acceptance criteria. |
| `DevSpec: Create action item` | `devspec.create` | Create a new action item from the agent. |
| `DevSpec: Continue session in local agent` | `devspec.session-brainstorm` | Hand off a DevSpec web chat session to the local agent. |
| `DevSpec: Log completed work` | `devspec.done` | Record ad-hoc work completed outside the action-item flow. |

### Utilities

| Command | Skill | Purpose |
|---|---|---|
| `DevSpec: Verify connection` | `devspec.verify-connection` | Ping mode (no git) or commit mode (setup wizard verification). |
| `DevSpec: Help` | `devspec.help` | Search official DevSpec product docs. |
| `DevSpec: Link commit to item` | `devspec.link` | Associate a git commit with an action item. |
| `DevSpec: Commit with tracking tag` | `devspec.commit` | Generate a `[devspec:<id>]` commit message and commit. |

### Autopilot (one-shot — no background polling)

Cursor cannot run a persistent polling loop like Claude Code's `/autopilot:start`. Instead, use **one-shot** processing — run the command again for each item, or pass `--items=<uuid1>,<uuid2>` for a targeted batch.

| Command | Skill | Purpose |
|---|---|---|
| `DevSpec Autopilot: Process next staged item` | `autopilot.process` | Claim and implement the next staged item (or `--items=` batch). |
| `DevSpec Autopilot: Show status` | `autopilot.status` | Queue counts, in-progress items, push/merge settings. |
| `DevSpec Autopilot: Show history` | `autopilot.history` | Recent completed and failed autopilot runs. |

> **Not available in Cursor:** `/autopilot:start` and `/autopilot:stop` (background polling loop). Use Claude Code for continuous autopilot.

Commits include a `[devspec:<id>]` tag so DevSpec's deployment webhook can link successful deploys back to the action item.

## Installation

### From VSIX (recommended)

1. Download the latest `devspec-autopilot.vsix` from the [Releases](https://github.com/DevSpecAI/cursor-devspec-plugin/releases) page.
2. In Cursor: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → select the file.
3. After install, run **`DevSpec: Set MCP token`** and paste a token from **Project Settings → Integrations**.
4. Restart Cursor so the new MCP server is loaded.

### From source

```bash
git clone https://github.com/DevSpecAI/cursor-devspec-plugin.git
cd cursor-devspec-plugin
npm install
npm run package      # produces devspec-autopilot.vsix
```

Then install the VSIX as above.

### Syncing skills from Claude plugin

When the Claude plugin commands change, regenerate Cursor skills:

```bash
npm run sync         # reads ../claude-code-devspec-autopilot/commands/
npm run package
```

## Configuration

Settings (Cursor: `File → Preferences → Settings`, search "DevSpec"):

| Setting | Default | Notes |
|---|---|---|
| `devspec.apiUrl` | _(empty)_ | DevSpec API URL. Prompted on first connect. |
| `devspec.mcpToken` | _(empty)_ | DevSpec MCP token (starts with `dvs_`). Per-machine. |

On first activation the extension shows a "Connect now?" notification. You can re-register any time with **`DevSpec: Register MCP server in Cursor config`**, or update the token with **`DevSpec: Set MCP token`**.

## Usage

Open the command palette (`Ctrl+Shift+P`) and type "DevSpec". Each skill command:

1. Optionally prompts for input (item ID, flags, etc.).
2. Loads the `SKILL.md` instructions for that skill.
3. Copies the combined prompt to your clipboard.
4. Paste into a **new Agent-mode chat** (`Ctrl+L`) to run.

## Troubleshooting

### "DevSpec MCP server is not reachable from this chat"

Cursor binds MCP tool availability when a chat thread opens. After changing MCP config or extension settings, **open a new Agent chat** and re-run the skill.

Action-mutating skills preflight-check `devspec__list_projects` before proceeding. If that fails:

1. Verify the `devspec` server is green in **Cursor Settings → MCP & Integrations**.
2. Run **`DevSpec: Register MCP server in Cursor config`** and restart Cursor.
3. Open a **new** Agent chat and re-run the skill.

## License

MIT — see [LICENSE](./LICENSE).
