# DevSpec for Cursor

**Build on your team’s best thinking.**

[DevSpec](https://devspec.ai) is where your team, your knowledge and your agents build software together, made for AI-native development from the ground up.

Bring your team's DevSpec work into Cursor — pick up tasks, brainstorm scope, and ship changes without leaving the terminal. This plugin connects Cursor's CLI agent (`cursor-agent`) to your DevSpec account over MCP so it can pull work into the chat, implement it, and record what it did back in DevSpec.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you can do with it

- **Work a task in chat.** Point the agent at a task and it implements the change, runs your project's tests, commits, and records what it did back on the task.
- **Work a batch in one go.** Tell the agent *"Work these DevSpec tasks in order: 4f2a, 9c1b, 2e7d"* — it reserves them so nobody else takes one mid-run, then claims and works them one at a time.
- **Drive a session from DevSpec.** Connect a Cursor session to DevSpec's **Agents page** and steer it from your browser or phone.
- **Use DevSpec directly from chat.** Query and update tasks, shared project memory, documents, and review queues in plain language.

---

## Before you start

You'll need:

- **Cursor's CLI agent** (`cursor-agent`).
- A **[DevSpec](https://devspec.ai)** account with at least one project connected to your git repositories.
- A **DevSpec API token**. Create one on DevSpec's [Agent setup page](https://app.devspec.ai/settings/agents) with **Create your token** (pick **Read & write**); it starts with `dvs_`.
  - **One token, everywhere.** Reuse the same token across every tool and every machine.
  - **Retrievable.** Reveal and copy it again any time on the [Agent setup page](https://app.devspec.ai/settings/agents).
- **Node.js 18+** (`node --version`).

---

## Install

Add this repository as a Cursor plugin marketplace:

```bash
cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin
```

Then enable it: run `cursor-agent`, type `/plugins`, and install **devspec-autopilot** from the marketplace you just added. **Adding a marketplace does not install the plugin** — installing it from `/plugins` is what loads the skills, hooks, and project rule.

### Updating

To update to a newer release, remove and re-add the marketplace, then reinstall **devspec-autopilot** from `/plugins`:

```bash
cursor-agent plugin marketplace remove devspec-autopilot
cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin
```

Then run `node scripts/setup-cursor.mjs --refresh` (if you manage `~/.cursor/mcp.json` via the setup script) and restart `cursor-agent`.

---

## Connect your token

Add a `devspec` entry to `~/.cursor/mcp.json` (macOS/Linux) or `%USERPROFILE%\.cursor\mcp.json` (Windows):

```json
{
  "mcpServers": {
    "devspec": {
      "url": "https://api.devspec.ai/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection",
      "headers": {
        "Authorization": "Bearer dvs_your_token_here",
        "x-devspec-plugin": "cursor/0.16.12"
      }
    }
  }
}
```

Or run the setup helper from a clone of this repository (it reads `DEVSPEC_MCP_TOKEN` or `~/.devspec/auth.json` and merges the `devspec` entry into `~/.cursor/mcp.json` without echoing your token):

```bash
DEVSPEC_MCP_TOKEN=dvs_… node scripts/setup-cursor.mjs
```

Restart `cursor-agent` afterwards so it picks up the server.

---

## Verify

Run `cursor-agent` and ask it to call the DevSpec `verify_agent_connection` tool, or run `/plugins` to confirm **devspec-autopilot** is installed.

### Skills

| Skill | What it does |
|---|---|
| `devspec.remote` | Connect this session to DevSpec's Agents page (`--new` or `--session <id>` to attach to a room) |
| `devspec.remote-stop` | Disconnect this session from the Agents page |
| `devspec.project` | Inspect project scope, manage folder defaults, or prepare a fresh chat for another project |
| `devspec.debug` | Start, inspect, stop, or export local Cursor diagnostics when requested |

---

## Project selection

Bare `/devspec.remote` resolves your project automatically when your repository's `origin` remote identifies one accessible project, or when the folder has a `.devspec/project.json` pin.

To choose a project explicitly for this conversation, run `/devspec.remote --project "Project name"` (or pass a project ID). Use `/devspec.project` to inspect the active project, remember or forget a folder default, or prepare a fresh Cursor chat for a different project.

### Shared session plans during remote control

When a qualifying multi-phase plan exists in an attached session, Cursor continues it across reconnects using its authoritative revision and advances milestones atomically. Plan awareness is room-wide and advisory. Native chats bind through Cursor's host conversation id; a manual chat without that id is accepted only when the host's minted-bond index has exactly one live, attached, capability-bound Cursor connection in the current workspace. Ambiguous sibling connections fail closed.

Cursor's native `agent --resume` behavior is preserved, and the plugin reports the host conversation identity as `local_session_id`.

---

## Contributing

Run the test suite:

```bash
npm test
```

Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
