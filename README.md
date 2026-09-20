# DevSpec for Cursor

Bring your team's DevSpec work into Cursor — pick up tasks, brainstorm scope, and ship changes without leaving the terminal.

[DevSpec](https://devspec.ai) tracks your team's tasks, bugs, and features — called **action items** — against your git repositories, along with the context, decisions, and history around them. This plugin connects Cursor's agent to your DevSpec account over MCP so it can pull that work into the chat, do it, and record what it did — all tracked in DevSpec.

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

- **Cursor's CLI agent** (`cursor-agent`). This is a CLI plugin: it is installed with `cursor-agent plugin`, and its hooks run in `cursor-agent` sessions. There is no VS Code extension and no VSIX.
- A **[DevSpec](https://devspec.ai)** account with at least one project connected to your git repo(s).
- A **DevSpec API token**. Create one in DevSpec under **You → Connections → Connect a tool** (pick **Read & write**); it starts with `dvs_`.
  - It's **account-wide.** Use the **same** token in every tool and on every machine — do **not** mint one per machine.
  - It's **retrievable.** Reveal and copy it again any time at **You → Connections** (no more show-once).
  - You don't paste a project id — the project for a run is resolved from your repo's git remote.
- **Node.js 18+** — needed by the installed agent hooks and remote-control scripts (check with `node --version`). Plain MCP tool access is provided by Cursor itself.

## Install

The plugin installs from this git repo as a custom marketplace — no clone, no VSIX.

```bash
cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin
```

Then enable it: run `cursor-agent`, type `/plugins`, and install **devspec-autopilot** from the
marketplace you just added. **Adding a marketplace does not install the plugin** — that second
step is what makes it load, and skipping it looks exactly like a working install until you go
looking for a hook.

`--git-ref <branch>` **pins** to a branch rather than tracking it — see updating, below.

### Updating

Remove and re-add. Do not use `marketplace update`:

```bash
cursor-agent plugin marketplace remove devspec-autopilot
cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin
```

`cursor-agent plugin marketplace update` prints `✓ Updated marketplace` and fetches nothing
new. Cursor resolves whatever ref you gave it to a commit SHA when you add the marketplace and
stores only that SHA — the branch name is not kept — so there is nothing left for `update` to
re-resolve and it re-fetches the same commit. Removing and re-adding resolves the branch afresh.
Measured against cursor-agent 2026.09.18; if a later version keeps the branch name, this section
should go.

Once it is enabled, the plugin provides:

- the two remote-control **skills** (`devspec.remote`, `devspec.remote-stop`),
- the agent **hooks** for remote-control telemetry and commit-provenance assistance,
- the managed **project rule** (`rules/devspec.mdc`), which Cursor picks up from the plugin.

Registering the MCP server is a separate step, below — Cursor reads MCP config only from
`~/.cursor/mcp.json` and a workspace `.cursor/mcp.json`, never from a plugin.

## Connect your token

Cursor reads MCP servers from your own config file, not from a plugin, so this is a one-time
edit you make. Add a `devspec` entry to your Cursor MCP config file:

```json
{
  "mcpServers": {
    "devspec": {
      "url": "https://api.devspec.ai/api/mcp",
      "headers": { "Authorization": "Bearer dvs_your_token_here" }
    }
  }
}
```

Use `https://api.devspecstaging.com/api/mcp` for staging.

If you have a clone of this repo, the same edit is scripted — it merges into an existing file
rather than replacing it, and never echoes your token back:

```bash
node scripts/setup-cursor.mjs --token dvs_…            # or set DEVSPEC_MCP_TOKEN
node scripts/setup-cursor.mjs --api-url https://api.devspecstaging.com
```

The config file lives at:

- **macOS / Linux:** `~/.cursor/mcp.json`
- **Windows:** `%USERPROFILE%\.cursor\mcp.json`

It points the server at the DevSpec MCP endpoint `https://api.devspec.ai/api/mcp` (the API host — the web app itself lives on `https://app.devspec.ai`) and sends your token as a Bearer header. **Restart `cursor-agent`** afterwards so it picks up the new server.

> **One token, everywhere.** The `dvs_` token is account-wide — reuse the same one across Cursor, your other coding tools, and every machine you work on. There's no need to generate a fresh token per machine. If you lose track of it, just reveal and copy it again at **You → Connections**.

## Verify

Run `cursor-agent` and ask it to call the DevSpec `verify_agent_connection` tool. You should see confirmation that the MCP server is reachable and connected as your DevSpec user.

To check the plugin itself loaded — a separate thing from MCP working — run `/plugins` and confirm **devspec-autopilot** is listed as installed.

### Skills

The plugin contributes two skills, invoked from a `cursor-agent` session:

| Skill | What it does |
|---|---|
| `devspec.remote` | Connect this session to DevSpec's Agents page |
| `devspec.remote-stop` | Disconnect this session from the Agents page |

Action-item, memory, help, and implementation operations are MCP tools used from the agent
session; they are not separate skills. Cursor receives concise tool discovery rather than a
giant static catalog; detailed schemas are resolved only when used.

### Shared session plans during remote control

The current `devspec://product/implementation-contract` decides whether work warrants a shared session plan. The threshold is deliberately high: routine investigation and one-run checks remain unplanned. When a qualifying attached-session plan exists, Cursor continues it across reconnects using its authoritative revision and advances meaningful milestones atomically.

Plan awareness is all-room and advisory: Cursor can see every active plan in the attached session, but another owner's plan grants no mutation authority. Same-owner cross-plan work and orphan adoption require explicit plan id plus expected revision and remain server-authorized.

Plan mutation uses a narrow connection-bound helper shipped with the plugin. It negotiates and stores a per-conversation capability without putting the secret in prompts or the global MCP config. The helper exposes the complete `manage_plan` schema only on demand (`manage-plan describe`) and accepts operations on stdin (`manage-plan use`). Native chats bind through Cursor's host conversation id; a manual chat without that id is accepted only when the host's minted-bond index has exactly one live, attached, capability-bound Cursor connection in the current workspace. Ambiguous sibling connections fail closed. Ordinary MCP tools keep using the normal Cursor registration in `~/.cursor/mcp.json`.

Cursor's existing Resume behavior is unchanged: CLI launches mint a native chat, run `agent --resume`, and stamp that chat id as `local_session_id`.

## How it finds the right project

You don't pass a project id in most cases. The plugin matches the git remote of the repo you're in to the DevSpec project that tracks it. If a single repo is tracked by more than one project, pass `--project-id=<id>` in the command's input.

## Open in Cursor from DevSpec

When you click **Open in Cursor** on the DevSpec web app, DevSpec opens a signed `devspec://` URL (Windows/Linux) or the macOS localhost bridge fallback.

### Setup

Run the handler installer once:

```bash
node scripts/open-handler.mjs --install
```

It:

1. **Windows / Linux:** registers `devspec://` in the OS (per-user, no admin)
2. **macOS:** starts the localhost bridge on port **42731**
3. Copies the handler to `~/.cursor/devspec/`
4. Runs on demand — no always-on bridge or Windows login startup entry

Or, without Node: **Windows** double-click `scripts/install-protocol-handler.cmd`;
**Linux / macOS** run `bash scripts/install-protocol-handler.sh`.

### What happens when you click the rocket

1. Cursor opens the mapped project folder.
2. A moment later, the Agent chat is pre-filled with your prompt — press Enter to send.

### macOS health check

`http://127.0.0.1:42731/health` should return `{"ok":true,"mode":"macos_bridge"}` when the fallback bridge is running.

DevSpec never receives or stores your local filesystem paths.

### Signing keys

The handler bundles `scripts/handoff-public-key.pem` for offline verification of the signed handoff.

## Contributing

This is a plain Node plugin — no build step, no bundler, no VSIX. Clone it and run the tests:

```bash
npm test
```

To try a change before pushing, point `cursor-agent` at your clone with
`cursor-agent --plugin-dir /path/to/cursor-devspec-plugin`.

Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
