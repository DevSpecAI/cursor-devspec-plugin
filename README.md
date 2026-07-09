# DevSpec Autopilot for Cursor

Cursor extension that connects Cursor's AI agent to the [DevSpec](https://devspec.ai) project management platform via MCP. Pick up action items, brainstorm scope, run one-shot autopilot, and ship work without leaving the editor.

This is the Cursor counterpart to the [Claude Code](https://github.com/DevSpecAI/claude-code-devspec-autopilot) and [Gemini CLI](https://github.com/DevSpecAI/gemini-cli-devspec-autopilot-extension) autopilot extensions. Skill instructions are synced from the Claude plugin (source of truth) via `npm run sync`.

## What it does

The extension does two things:

1. **Auto-registers a DevSpec MCP server** in `~/.cursor/mcp.json` so Cursor's chat agent can call DevSpec tools (list action items, claim work, generate commit messages, link commits, etc.).
2. **Optionally installs project rules** at `.cursor/rules/devspec.mdc` — always-on guidance to check DevSpec first, create/claim action items before editing, commit/push per MCP execution settings, and tag commits. Installed automatically in git repos on first connect (configurable); upgraded automatically when the bundled rules version increases; or run **`DevSpec: Install rules`** manually.
3. **Adds twelve DevSpec commands** to Cursor's command palette. Each loads a curated `SKILL.md` prompt (dot-named to match Claude), optionally prompts for input, and copies the combined prompt to the clipboard so you can paste it into Cursor chat.

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
| `DevSpec: Manage repo folder mappings` | — | View, re-point, or clear stored GitHub slug → local folder mappings for rocket-button deep links. |

### Rocket-button deep links (open project from DevSpec)

When you click **Open in Cursor** on the DevSpec web app, DevSpec opens:

`http://127.0.0.1:42731/open?repo=owner/name`

A small **open bridge** process (shipped with this extension) must be running on that port. After opening the folder it can also pre-fill Cursor Agent chat via `cursor://anysphere.cursor-deeplink/prompt` when DevSpec passes a `prompt=` query param on the rocket link.

**One-time setup** (after installing the VSIX):

```bash
cd path/to/cursor-devspec-plugin
npm run open-bridge:install
```

Or from the installed extension folder:

```bash
node "%USERPROFILE%/.cursor/extensions/devspecai.devspec-autopilot-0.2.5/scripts/open-bridge.mjs"
```

Leave it running, or re-run after reboot. Command Palette → **DevSpec: Start open bridge** also works when the extension is loaded in classic Cursor windows.

The bridge resolves the GitHub slug to a folder on your machine:

1. **Auto-learn** — while active in a git workspace, it records `origin` → folder automatically.
2. **One-time picker** — the first time a slug has no mapping, choose the local clone once; the choice is saved.
3. **Manage mappings** — run **`DevSpec: Manage repo folder mappings`** to re-point or forget a stored path.

You should see a brief browser confirmation and Cursor opening the project folder. If the browser says **connection refused**, start the open bridge (see above). If the repo is unmapped, use **DevSpec: Manage repo folder mappings** in Cursor.

DevSpec never receives or stores your local filesystem paths.

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

### From VSIX

1. Download the latest `devspec-autopilot.vsix` from the [Releases](https://github.com/DevSpecAI/cursor-devspec-plugin/releases) page.
2. In Cursor: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → select the file.
3. **Restart Cursor** (`Ctrl+Shift+P` → **Developer: Reload Window**). New commands and the MCP server do not load until the extension host reloads.
4. Run **`DevSpec: Set MCP token`** and paste a token from **You → Connections** in DevSpec.
5. **Install project rules** — the extension writes `.cursor/rules/devspec.mdc` (always-on DevSpec workflow guidance). It installs automatically by default when MCP connects; if missing, run **`DevSpec: Install rules`** from the command palette (git repo required).
6. Open a **new Agent chat** (`Ctrl+L`) and run **DevSpec: Verify connection** to confirm everything works.

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
| `devspec.autoInstallRules` | `always` | `prompt` · `always` · `never` — install `.cursor/rules/devspec.mdc` in git repos. |

On first activation the extension shows a "Connect now?" notification. You can re-register any time with **`DevSpec: Register MCP server in Cursor config`**, update the token with **`DevSpec: Set MCP token`**, or install rules with **`DevSpec: Install rules`**.

### DevSpec commands do not appear after install

Restart Cursor (`Ctrl+Shift+P` → **Developer: Reload Window**). Installing a VSIX updates files on disk but the running extension host keeps the old version until reload.

### Project rules file missing

Run **`DevSpec: Install rules`** (`Ctrl+Shift+P`). The file lands at `.cursor/rules/devspec.mdc` in your git repo root. Default setting `devspec.autoInstallRules` is `always` — rules install on first connect; set to `prompt` to ask each workspace, or `never` to skip.

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
