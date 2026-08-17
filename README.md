# DevSpec for Cursor

Bring your team's DevSpec work into Cursor — pick up tasks, brainstorm scope, and ship changes without leaving the editor.

[DevSpec](https://devspec.ai) tracks your team's tasks, bugs, and features — called **action items** — against your git repositories, along with the context, decisions, and history around them. This extension connects Cursor's AI agent to your DevSpec account over MCP so it can pull that work into the chat, do it, and record what it did — all tracked in DevSpec.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you can do with it

- **Work a task in chat.** Point the agent at an action item and it implements the change, runs your project's tests, commits, and records what it did back on the task — ready for a human to review.
- **Work a batch in one go.** Pass several task ids to `devspec.work` — it reserves them, then claims and works the members one at a time, in order.
- **Drive a session from DevSpec.** Connect a Cursor session to DevSpec's **Agents page** and steer it from your browser or phone. (Needs Node.js — see below.)
- **Open in Cursor from DevSpec.** Click a task's rocket in the DevSpec web app and Cursor opens the right repo with your prompt pre-filled. → [Open in Cursor](#open-in-cursor-from-devspec)
- **Small conveniences.** Create tasks, make tracked commits, link commits to tasks, and ask DevSpec's docs questions — all from the command palette.

Everything runs against your own DevSpec account and repositories, using an API token you control.

## Before you start

You'll need:

- **Cursor — the classic IDE.** DevSpec works through Cursor's **Agent chat**, which you open with **Ctrl+L** / **Cmd+L**. It does **not** work reliably in Cursor's newer "Agents Window" — stick to classic IDE Agent chat.
- A **[DevSpec](https://devspec.ai)** account with at least one project connected to your git repo(s).
- A **DevSpec API token**. Create one in DevSpec under **You → Connections → Connect a tool** (pick **Read & write**); it starts with `dvs_`.
  - It's **account-wide.** Use the **same** token in every tool and on every machine — do **not** mint one per machine.
  - It's **retrievable.** Reveal and copy it again any time at **You → Connections** (no more show-once).
  - You don't paste a project id — the project for a run is resolved from your repo's git remote.
- **Node.js 18+** — only needed for **remote control** and working dispatched batches (check with `node --version`). Plain MCP tool access — working a task in chat, creating items, asking the docs — doesn't require it, but you'll want it installed for the full feature set.

## Install

The extension ships as a VSIX.

1. Get `devspec-autopilot.vsix` from the [repo](https://github.com/DevSpecAI/cursor-devspec-plugin) (grab a release, or build one — see [Contributing](#contributing)).
2. In Cursor, open the command palette (**Ctrl+Shift+P** / **Cmd+Shift+P**) and run **Extensions: Install from VSIX…**
3. Pick the `.vsix` file, and reload Cursor if prompted.

On first activation the extension:

- registers the DevSpec **MCP server** in your Cursor config,
- installs project rules at `.cursor/rules/devspec.mdc` in git repos you open,
- adds the **DevSpec: …** commands to the command palette.

## Connect your token

Open the command palette and run **DevSpec: Set MCP token**. Paste your `dvs_…` token. The first time you connect it also asks for your DevSpec **API URL** — enter `https://devspec.ai`.

The extension writes the connection into your Cursor MCP config file:

- **macOS / Linux:** `~/.cursor/mcp.json`
- **Windows:** `%USERPROFILE%\.cursor\mcp.json`

It points the server at the DevSpec MCP endpoint `https://devspec.ai/api/mcp` and sends your token as a Bearer header. **Restart Cursor** afterwards so it picks up the new server.

> **One token, everywhere.** The `dvs_` token is account-wide — reuse the same one across Cursor, your other coding tools, and every machine you work on. There's no need to generate a fresh token per machine. If you lose track of it, just reveal and copy it again at **You → Connections**.

## Verify

Open the command palette and run **DevSpec: Verify connection** (leave the verification ID blank for a quick ping). It copies a check prompt to your clipboard — paste it into Cursor's Agent chat (**Ctrl+L**) and send. You should see confirmation that you're connected as your DevSpec user.

That clipboard-paste flow is how every DevSpec skill runs: a **DevSpec: …** palette command copies a ready-to-run prompt, and you paste it into Agent chat to kick it off.

### Commands

Every command is under the **DevSpec:** prefix in the command palette.

| Command | What it does |
|---|---|
| DevSpec: Work on action item | Pick up an action item, implement it, and record the work |
| DevSpec: Brainstorm action item | Talk through scope and approach before writing code |
| DevSpec: Create action item | Create a new action item from the editor |
| DevSpec: Commit with tracking tag | Write a tracked commit message and commit |
| DevSpec: Link commit to item | Link an existing commit to an action item |
| DevSpec: Log completed work | Log work you already finished (commits, testing notes) |
| DevSpec: Help | Ask a question and get an answer from DevSpec's docs |
| DevSpec: Verify connection | Confirm the plugin is connected |
| DevSpec: Connect remote control | Connect this session to DevSpec's Agents page |
| DevSpec: Disconnect remote control | Disconnect this session from the Agents page |

Setup and utility commands are also in the palette: **DevSpec: Set MCP token**, **DevSpec: Register MCP server in Cursor config**, **DevSpec: Install rules**, **DevSpec: Install remote-control mirror hooks**, and **DevSpec: Manage repo folder mappings**.

## How it finds the right project

You don't pass a project id in most cases. The extension matches the git remote of the repo you're in to the DevSpec project that tracks it. If a single repo is tracked by more than one project, pass `--project-id=<id>` in the command's input.

## Open in Cursor from DevSpec

When you click **Open in Cursor** on the DevSpec web app, DevSpec opens a signed `devspec://` URL (Windows/Linux) or the macOS localhost bridge fallback.

### Automatic setup (recommended)

Installing this extension and connecting DevSpec MCP **automatically**:

1. **Windows / Linux:** registers `devspec://` in the OS (per-user, no admin)
2. **macOS:** starts the localhost bridge on port **42731**
3. Copies the handler to `~/.cursor/devspec/`
4. Runs on demand — no always-on bridge or Windows login startup entry

You can also run **DevSpec: Install protocol handler** from the command palette.

### Manual setup (extension not installed)

**Windows:** double-click `scripts/install-protocol-handler.cmd`

**Linux / macOS:**

```bash
bash scripts/install-protocol-handler.sh
```

### What happens when you click the rocket

1. Cursor opens the mapped project folder.
2. A moment later, the Agent chat is pre-filled with your prompt — press Enter to send.

### macOS health check

`http://127.0.0.1:42731/health` should return `{"ok":true,"mode":"macos_bridge"}` when the fallback bridge is running.

DevSpec never receives or stores your local filesystem paths.

### Signing keys

The handler bundles `scripts/handoff-public-key.pem` for offline verification of the signed handoff.

## Contributing

The extension is TypeScript bundled with esbuild and packaged with `vsce`. To build a VSIX locally:

```bash
npm install
npm run package   # → devspec-autopilot.vsix
```

Skills are Markdown prompts synced from the Claude Code plugin via `npm run sync`. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
