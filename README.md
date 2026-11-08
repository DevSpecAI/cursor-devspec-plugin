# DevSpec for Cursor

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

Installing the DevSpec plugin connects Cursor's command-line agent (`cursor-agent`) to your DevSpec projects, giving your agent durable project memory, structured task execution, automatic commit tracking, and live remote control from your phone or browser.

> **Command line only, for now.** The plugin is for Cursor's command-line agent. The Cursor editor isn't supported yet.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Why DevSpec + Cursor?

- **Shared team memory that never goes stale.** The agent recalls the decisions, conventions, risks and reference documents that apply to the code it's touching. When you decide something together, it records the decision in DevSpec, so every teammate and every agent stays aligned.
- **Steer Cursor live from your phone or the web.** Put any `cursor-agent` conversation on your project's **Agents** page with `/devspec-remote`. Chat with it from [devspec.ai](https://devspec.ai), work alongside teammates in shared session rooms, answer the agent's questions and polls, and follow multi-step plans as they run.
- **Tasks, criteria and automatic commit tracking.** The agent claims tasks with their full context. While a task is claimed, its commits are tagged with the task automatically, pull requests are linked, and test evidence is recorded against each acceptance criterion.
- **Protected intent.** DevSpec checks changes against your team's recorded decisions and requirements, and catches accidental reversals and duplicate work before they land.

---

## Quick start

You need [Cursor's command-line agent](https://cursor.com/docs/cli/installation), a [DevSpec](https://devspec.ai) account with a project, and **Node.js 18 or later** with **git** (`node --version`; get Node.js from [nodejs.org](https://nodejs.org/en/download)).

### 1. Install the plugin

Start `cursor-agent`, type `/plugin`, search the marketplace for **DevSpec**, and install it **for your user**, so it works in every folder. You can also use **Add to Cursor** on DevSpec's page in the [Cursor Marketplace](https://cursor.com/marketplace).

### 2. Approve DevSpec for the agent

In `cursor-agent`, type `/mcp` and open the DevSpec server (`devspec-cursor`). Choose **Enable** if Cursor asks, then **Login**. Your browser opens DevSpec's approval page for Cursor: sign in to DevSpec if asked and click **Allow**. The agent now has its DevSpec tools. There is no token to create, copy or paste.

### 3. Connect

In a git repository linked to your DevSpec project, type `/devspec-remote`. The first time, your browser opens DevSpec's approval page once more, again for Cursor: click **Allow**. This second approval is for remote control and commit tracking, which run in the background, where Cursor can't share its own sign-in. Both approvals are for the same Cursor app, so DevSpec's Agent setup page lists Cursor once. The conversation then appears on the project's **Agents** page, ready to take work from your browser or phone. Use `/devspec-remote --new` to open a new session room for it.

You stay signed in until you sign out or disconnect Cursor on DevSpec's Agent setup page: both sign-ins renew themselves. To check everything is working, ask the agent: *"Check my DevSpec connection."* It tells you which DevSpec account it is connected as. If DevSpec's tools are missing, type `/mcp` to see whether Cursor is signed in to DevSpec.

**Working on a machine your browser can't reach** (over SSH, say)? `/devspec-remote` gives you a link instead of opening a browser. Open it on your own computer, click **Allow**, copy the code the page shows, and paste it back into the chat; the agent finishes signing in and connects.

**Signing out.** Ask the agent to sign DevSpec's background features out, or disconnect Cursor on DevSpec's [Agent setup](https://app.devspec.ai/settings/agents) page. If remote control's sign-in stops working, the plugin tells you so and how to sign in again: run `/devspec-remote` and approve once more.

> **Tip for phone and remote control:** `cursor-agent` asks for your approval before running commands, and a remotely driven agent waits at your desk until you give it. Choose **Run Everything** for the conversation: press **Shift+Tab** at the first approval prompt, or type `/run-everything`. Cursor offers to make it your default after you've chosen it a few times. You can also start with `cursor-agent --yolo`.

---

## Commands

You can ask the agent to do anything in DevSpec in plain words (*"Work on DevSpec task 4f2a"*, *"What did we decide about caching?"*, *"Create a task for the login redirect bug"*). The plugin also adds these slash commands:

| Command | What it does |
|---|---|
| `/devspec-remote` | Puts this conversation on your project's **Agents** page, ready to take work from your browser or phone. |
| `/devspec-remote --new` | Connects and starts a new DevSpec session for this conversation, shared with the project. Add `--private` to make it visible only to you. |
| `/devspec-remote --session <id>` | Connects and joins an existing DevSpec session. |
| `/devspec-remote --project "<name>"` | Connects to that project for this conversation only, without changing the folder's default. |
| `/devspec-remote-stop` | Disconnects this conversation from DevSpec, leaving other `cursor-agent` conversations connected. |
| `/devspec-project` | Shows this conversation's project, chooses another one, or remembers or forgets a default project for the folder. |
| `/devspec-debug` | Collects diagnostics on your machine while you look into a problem. Nothing is uploaded unless you ask. |

**Choosing a project.** The agent finds your project by itself when your repository belongs to one DevSpec project, or when the folder has a `.devspec/project.json` file naming one. Otherwise it asks you. Moving to a different project needs a fresh conversation, so nothing carries over from one project to another. If you attach the agent to a DevSpec session that has a shared plan, it picks the plan up where it left off after it reconnects.

**Commit tracking.** While a conversation is connected, each commit the agent makes in one of your project's repositories is reported to DevSpec and credited to Cursor. When exactly one task is claimed, the task's reference is added to the commit message for the agent. A commit with no task to link it to is stopped before anything changes, and the agent is told how to recover. Repositories that aren't part of the project are left alone. On native Windows only simple `git commit` commands are tracked; use WSL for full commit tracking.

---

## Updates

New releases reach you through the Cursor Marketplace once Cursor has reviewed them. Restart `cursor-agent` to start using a new release. What changed in each release is in [CHANGELOG.md](./CHANGELOG.md).

**Coming from an earlier version?** DevSpec no longer uses a token. If you added a `devspec` entry with a token to `~/.cursor/mcp.json` (on Windows, `%USERPROFILE%\.cursor\mcp.json`), remove that entry and restart `cursor-agent`: while it is there, Cursor uses its token for the agent's DevSpec tools instead of signing in. Then approve DevSpec as in steps 2 and 3. A token you saved in the plugin's settings is no longer used.

**Coming from `devspec-autopilot`?** That earlier version of the plugin won't update to DevSpec. In `cursor-agent`, type `/plugin` and uninstall **devspec-autopilot**, run `cursor-agent plugin marketplace remove devspec-autopilot`, then install DevSpec as above.

---

## How it works & data handling

For transparency and security review, here is what the plugin connects to, runs and stores:

- **Connection to DevSpec.** The agent's DevSpec tools talk over HTTPS to `https://api.devspec.ai/api/mcp`, signed in through Cursor's own sign-in with your approval. Remote control and commit tracking sign in separately, through the same Cursor app and your approval in the browser; the approval comes back to a short-lived listener on your own machine (`127.0.0.1`), or as a code you paste, and never by checking a server for it.
- **While you're connected.** `/devspec-remote` starts a small Node.js listener in the background for that conversation. It checks DevSpec for messages addressed to the agent and stops when you disconnect or `cursor-agent` exits.
- **Hooks.** The plugin's hooks:
  - add this conversation's DevSpec connection and project to the agent's DevSpec calls;
  - report the agent's progress and model to the session it's attached to;
  - while you're connected, put a small `git` stand-in in front of the agent's shell commands, so commits are tagged and reported. The stand-in runs your own git unchanged, and nothing is installed in your repositories or git configuration.
- **Files on your machine.**
  - `~/.devspec/cursor/auth.json` holds remote control's and commit tracking's sign-in, one per DevSpec server, renewed automatically and readable only by you. Nothing else reads it, and the plugin reads no other tool's sign-in.
  - `~/.devspec/` also holds each connection's state, the session's recent messages, commit tracking records and logs, readable only by you.
  - `.devspec/project.json` is written in a repository only when you ask `/devspec-project` to remember a default project.

---

## Learn more

- **Website and sign-up:** [devspec.ai](https://devspec.ai)
- **Agent setup (connected tools):** [app.devspec.ai/settings/agents](https://app.devspec.ai/settings/agents)
- **Privacy policy:** [devspec.ai/privacy](https://devspec.ai/privacy)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

---

## Contributing and testing new versions

For people working on the plugin or trying a release before it's in the Marketplace:

- **Try an unreleased version.** Uninstall any **DevSpec** copy from `/plugin` first, because an installed copy with the same name takes precedence over a local one. Then clone the plugin into Cursor's local plugins folder and restart `cursor-agent`:

  ```bash
  git clone -b staging https://github.com/DevSpecAI/cursor-devspec-plugin ~/.cursor/plugins/local/devspec
  ```

  To move to the latest version, run `git -C ~/.cursor/plugins/local/devspec pull` and restart `cursor-agent`. A local copy signs in through the browser like an installed one.
- **Develop against a checkout.** Run `cursor-agent --plugin-dir <path-to-checkout>`.
- **Another DevSpec server.** Start `cursor-agent` with the server and its Cursor sign-in app in the environment, for example DevSpec staging:

  ```bash
  DEVSPEC_API_URL=https://api.devspecstaging.com DEVSPEC_CURSOR_CLIENT_ID=0gPBpmMnw37junr4 cursor-agent
  ```

  Cursor's own connection and the background features both read these, so both use that server; nothing in a settings file changes. Each server keeps its own sign-in, so switching back needs no new approval. (Setting the same values under the plugin's **Configure variables** moves only the agent's DevSpec tools, not remote control and commit tracking.)
- **Signing the background features in or out from a terminal.** `node <plugin-folder>/scripts/devspec-login.mjs` signs in through the browser; add `--code` on a machine the browser can't reach, `--status` to see where things stand, or `--sign-out` to sign out of that server only. The server is the one above, or `--server https://api.devspecstaging.com`.
- **Machines with no browser** (CI, cloud workers). Set `DEVSPEC_MCP_TOKEN` (and `DEVSPEC_MCP_URL` for another server) for the background features. It takes precedence over a browser sign-in, and the plugin says so whenever both are present.
- **Simulate a customer install.** Add this repository as a plugin marketplace with `cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin`, then install **devspec** from `/plugin`. Adding a marketplace does not install the plugin; installing it from `/plugin` is what loads it. A copy installed this way stays on the version you installed: to move on, run `cursor-agent plugin marketplace remove devspec`, add it again and reinstall. `cursor-agent plugin marketplace update` does not bring a newer version.
- **Resuming chats.** `cursor-agent --resume` works as usual; the plugin reports Cursor's conversation id to DevSpec as `local_session_id`. A chat without a Cursor conversation id is matched to a DevSpec connection only when exactly one live, attached Cursor connection is in the folder; with several, the plugin refuses rather than guess.
- **Tests.** Run them with `npm test`.

## License

[MIT](./LICENSE)
