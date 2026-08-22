# DevSpec for Cursor

Bring your team's DevSpec work into Cursor — pick up tasks, brainstorm scope, and ship changes without leaving the editor.

[DevSpec](https://devspec.ai) tracks your team's tasks, bugs, and features — called **action items** — against your git repositories, along with the context, decisions, and history around them. This extension connects Cursor's AI agent to your DevSpec account over MCP so it can pull that work into the chat, do it, and record what it did — all tracked in DevSpec.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you can do with it

- **Work a task in chat.** Point the agent at an action item and it implements the change, runs your project's tests, commits, and records what it did back on the task — ready for a human to review.
- **Work a batch in one go.** Tell the Agent *"Work these DevSpec items in order: 4f2a, 9c1b, 2e7d"* — it reserves them so nobody else takes one mid-run, then claims and works them one at a time. DevSpec's web app has a copy button that writes that line for you.
- **Drive a session from DevSpec.** Connect a Cursor session to DevSpec's **Agents page** and steer it from your browser or phone. (Needs Node.js — see below.)
- **Open in Cursor from DevSpec.** Click a task's rocket in the DevSpec web app and Cursor opens the right repo with your prompt pre-filled. → [Open in Cursor](#open-in-cursor-from-devspec)
- **Use DevSpec directly from Agent chat.** The MCP tools exposed in chat cover action items, tracked implementations, project memory, and product help.

Everything runs against your own DevSpec account and repositories, using an API token you control.

## Before you start

You'll need:

- **Cursor — the classic IDE.** DevSpec works through Cursor's **Agent chat**, which you open with **Ctrl+L** / **Cmd+L**. It does **not** work reliably in Cursor's newer "Agents Window" — stick to classic IDE Agent chat.
- A **[DevSpec](https://devspec.ai)** account with at least one project connected to your git repo(s).
- A **DevSpec API token**. Create one in DevSpec under **You → Connections → Connect a tool** (pick **Read & write**); it starts with `dvs_`.
  - It's **account-wide.** Use the **same** token in every tool and on every machine — do **not** mint one per machine.
  - It's **retrievable.** Reveal and copy it again any time at **You → Connections** (no more show-once).
  - You don't paste a project id — the project for a run is resolved from your repo's git remote.
- **Node.js 18+** — needed by the installed agent hooks and remote-control scripts (check with `node --version`). Plain MCP tool access is provided by Cursor itself.

## Install

The extension ships as a VSIX.

1. Get `devspec-autopilot.vsix` from the [repo](https://github.com/DevSpecAI/cursor-devspec-plugin) (grab a release, or build one — see [Contributing](#contributing)).
2. In Cursor, open the command palette (**Ctrl+Shift+P** / **Cmd+Shift+P**) and run **Extensions: Install from VSIX…**
3. Pick the `.vsix` file, and reload Cursor if prompted.

On first activation the extension:

- registers the DevSpec **MCP server** in your Cursor config,
- installs project rules at `.cursor/rules/devspec.mdc` in git repos and worktrees you open,
- installs Cursor agent hooks for remote-control telemetry and commit-provenance assistance,
- adds the setup and remote-control **DevSpec: …** commands to the command palette.

## Connect your token

Open the command palette and run **DevSpec: Set MCP token**. Paste your `dvs_…` token. The first time you connect it also asks for your DevSpec **API URL** — enter `https://devspec.ai`.

The extension writes the connection into your Cursor MCP config file:

- **macOS / Linux:** `~/.cursor/mcp.json`
- **Windows:** `%USERPROFILE%\.cursor\mcp.json`

It points the server at the DevSpec MCP endpoint `https://devspec.ai/api/mcp` and sends your token as a Bearer header. **Restart Cursor** afterwards so it picks up the new server.

> **One token, everywhere.** The `dvs_` token is account-wide — reuse the same one across Cursor, your other coding tools, and every machine you work on. There's no need to generate a fresh token per machine. If you lose track of it, just reveal and copy it again at **You → Connections**.

## Verify

Open Cursor's Agent chat (**Ctrl+L** / **Cmd+L**) and ask it to call the DevSpec `verify_agent_connection` tool. You should see confirmation that the MCP server is reachable and connected as your DevSpec user.

### Commands

The extension currently contributes these command-palette commands:

| Command | What it does |
|---|---|
| DevSpec: Connect remote control | Connect this session to DevSpec's Agents page |
| DevSpec: Disconnect remote control | Disconnect this session from the Agents page |
| DevSpec: Set MCP token | Store the account-wide MCP token |
| DevSpec: Register MCP server in Cursor config | Write or refresh Cursor's MCP registration |
| DevSpec: Install rules | Install or overwrite the managed project rule |
| DevSpec: Install agent hooks | Install remote-control telemetry and commit-provenance hooks |
| DevSpec: Manage repo folder mappings | Manage local folders used by signed handoffs |
| DevSpec: Install protocol handler | Register signed `devspec://` handoffs |
| DevSpec: Install handoff handler | Install the local handoff bridge |
| DevSpec: Start handoff handler | Start the local handoff bridge |

Action-item, memory, help, and implementation operations are MCP tools used from Agent chat; they are not separate command-palette commands. Cursor receives concise tool discovery rather than a giant static catalog; detailed schemas are resolved only when used.

### Shared session plans during remote control

The current `devspec://product/implementation-contract` decides whether work warrants a shared session plan. The threshold is deliberately high: routine investigation and one-run checks remain unplanned. When a qualifying attached-session plan exists, Cursor continues it across reconnects using its authoritative revision and advances meaningful milestones atomically.

Plan awareness is all-room and advisory: Cursor can see every active plan in the attached session, but another owner's plan grants no mutation authority. Same-owner cross-plan work and orphan adoption require explicit plan id plus expected revision and remain server-authorized.

Plan mutation uses a narrow connection-bound helper installed with the extension. It negotiates and stores a per-conversation capability without putting the secret in prompts or the global MCP config. The helper exposes the complete `manage_plan` schema only on demand (`manage-plan describe`) and accepts operations on stdin (`manage-plan use`). Native chats bind through Cursor's host conversation id; a manual chat without that id is accepted only when the host's minted-bond index has exactly one live, attached, capability-bound Cursor connection in the current workspace. Ambiguous sibling connections fail closed. Ordinary MCP tools keep using the normal Cursor registration in `~/.cursor/mcp.json`.

Cursor's existing Resume behavior is unchanged: CLI launches still mint a native chat, run `agent --resume`, and stamp that chat id as `local_session_id`; classic IDE conversations continue using Cursor's supplied conversation id when available.

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

The two remote-control skills are packaged in this plugin. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
