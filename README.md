# DevSpec for Cursor CLI

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

This plugin is for developers who already have a Cursor subscription and want to use **Cursor CLI** (`cursor-agent`) with DevSpec. It connects `cursor-agent` to your DevSpec projects for durable project memory, structured task execution, automatic commit tracking, and live remote control from your phone or browser.

> **Cursor CLI only.** This plugin is for Cursor's command-line agent (`cursor-agent`). The Cursor editor is not supported.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Why DevSpec + Cursor CLI?

- **Shared team memory that never goes stale.** On commands sent from DevSpec, the agent automatically receives the project's requirements, decisions, conventions, risks, plans, and reference documents that apply to what you asked. When you decide something together, it records the decision in DevSpec after you confirm, so every teammate and every agent stays aligned.
- **Steer Cursor CLI live from your phone or the web.** Put any `cursor-agent` conversation on your project's **Agents** page with `/devspec-remote`. Chat with it from [devspec.ai](https://devspec.ai), work alongside teammates in shared session rooms, answer the agent's questions and polls, and follow multi-step plans as they run.
- **Tasks, criteria and automatic commit tracking.** The agent claims tasks with their full context. While a task is claimed, its commits are tagged with the task automatically, pull requests are linked, and test evidence is recorded against each acceptance criterion.
- **Protected intent.** DevSpec checks changes against your team's recorded decisions and requirements, catches accidental reversals and duplicate work before they land, and hands checks and notices to a working agent between steps.

---

## Quick start

You need an active Cursor subscription with [Cursor CLI](https://cursor.com/docs/cli/installation) (`cursor-agent`), a [DevSpec](https://devspec.ai) account with a project, and **Node.js 18 or later** with **git** (`node --version`; get Node.js from [nodejs.org](https://nodejs.org/en/download)).

### 1. Install the plugin

Start `cursor-agent`, type `/plugin`, search the Marketplace for **DevSpec for Cursor CLI** (`devspec`), and install it **for your user** so it works in every folder. You can also use **Add to Cursor** on DevSpec's page in the [Cursor Marketplace](https://cursor.com/marketplace).

### 2. Approve DevSpec for Cursor CLI

In `cursor-agent`, type `/mcp` and open DevSpec's server (**`Devspec-cursor (plugin)`**, shown as `plugin-devspec-devspec-cursor` in CLI output). Choose **Enable** if Cursor asks, then **Login**. Your browser opens DevSpec's approval page for Cursor: sign in to DevSpec if asked, click **Allow**, and restart `cursor-agent` so the agent's DevSpec tools and connection load cleanly.

> **Look for `Devspec-cursor (plugin)` specifically.** If you also use DevSpec in Claude Code, Cursor imports your Claude Code plugins automatically, so `/mcp` may also show a separate `Devspec (plugin)` entry (`plugin-devspec-devspec`) with an `Invalid URL` error. Ignore that entry and select **`Devspec-cursor (plugin)`** instead — Claude Code's plugin stands aside inside Cursor. Cursor also stores `/mcp` approvals per repository folder, so opening a new folder for the first time may ask for a quick **Login** → **Allow** there too.

### 3. Connect

In a git repository linked to your DevSpec project, type `/devspec-remote`. The first time, your browser opens DevSpec's approval page once more, again for Cursor: click **Allow**. This second approval is for remote control and commit tracking, which run in the background where Cursor cannot share its own sign-in. Both approvals use the same Cursor app, so DevSpec's Agent setup page lists Cursor once. The conversation then appears on the project's **Agents** page, ready to take work from your browser or phone. Use `/devspec-remote --new` to open a new session room for it.

You stay signed in until you sign out or disconnect Cursor on DevSpec's [Agent setup](https://app.devspec.ai/settings/agents) page: both sign-ins renew automatically. To check everything is working, ask the agent: *"Check my DevSpec connection."* It tells you which DevSpec account it is connected as. If DevSpec's tools are missing, type `/mcp` to check Cursor's sign-in status.

**Working on a machine your browser can't reach** (over SSH, say)? `/devspec-remote` gives you a link instead of opening a browser. Open it on your own computer, click **Allow**, copy the code the page shows, and paste it back into the chat; the agent finishes signing in and connects.

**Signing out.** Ask the agent to sign DevSpec's background features out, or disconnect Cursor on DevSpec's [Agent setup](https://app.devspec.ai/settings/agents) page. If remote control's sign-in ends, the plugin tells you and lets you approve again with `/devspec-remote`.

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

**Commit tracking.** While a conversation is connected, each commit the agent makes in one of your project's repositories is reported to DevSpec and credited to Cursor. When exactly one task is claimed, the task's reference is added to the commit message for the agent. When several are claimed, the commit is stopped before anything changes and the agent is asked which task it belongs to. A commit made with no task claimed, such as a dependency update or an automation run, goes through as written, with a short note telling the agent how to link its next commit to a task. If the agent claims a task and the plugin cannot record that claim, it never adds a different task's reference instead. What the plugin may and may not do to a commit follows the commit provenance rules DevSpec serves to every coding agent (`commit_provenance_contract` in `devspec://product/implementation-contract`). Repositories that aren't part of the project are left alone. On native Windows only simple `git commit` commands are tracked; use WSL for full commit tracking.

---

## Updates

New releases reach you through the Cursor Marketplace. Restart `cursor-agent` to start using a new release. What changed in each release is in [CHANGELOG.md](./CHANGELOG.md).

---

## How it works & data handling

For transparency and security review, here is what the plugin connects to, sends to DevSpec, runs locally, and stores on your machine:

- **Connection & sign-in.** The agent's DevSpec tools talk over HTTPS to `https://api.devspec.ai/api/mcp` using Cursor's built-in OAuth sign-in. Remote control and commit tracking use OAuth 2.1 with PKCE through the same Cursor app and your approval in the browser; the approval returns to a short-lived local listener on `127.0.0.1`, or as a code you paste on remote/SSH machines, and never by polling a server.
- **Background listener while connected.** `/devspec-remote` starts a small Node.js listener in the background for that conversation. It receives room commands, DevSpec notices, check jobs, and automation runs over HTTPS, and stops when you disconnect or `cursor-agent` exits.
- **What the plugin sends to DevSpec when connected:**
  - **Tool calls & attribution:** attaches this conversation's DevSpec connection, project, and active request reference to the agent's DevSpec tool calls.
  - **Project recall (`turn-recall`):** for each message or automation run sent from a DevSpec room, sends its text to DevSpec to retrieve relevant project records (requirements, decisions, conventions, documents, plans, and past work). Check jobs and DevSpec notices are never sent to recall.
  - **Live room transcript & work trail:** when attached to a DevSpec session room, sends prompts you type at the terminal (when Cursor invokes the prompt hook), live tool activity including shell commands and shell output, file edit summaries, the agent's thinking (`afterAgentThought`), model and session telemetry, turn start/end state, and Cursor's error or usage-limit messages (so DevSpec can route check jobs to another agent while a usage limit is active).
  - **Commit tracking:** puts a private `git` stand-in first on `PATH` for the conversation's shell commands so commits in linked project repositories are tagged when one task is claimed and reported to DevSpec (commit SHA, branch, and repository). The stand-in runs your own `git` unchanged, and nothing is installed in your repositories or git configuration.
- **Files written on your machine:**
  - `~/.devspec/cursor/auth.json` (`0600`): remote control and commit tracking browser sign-ins, one per DevSpec server, renewed automatically and readable only by you. Nothing else reads it, and the plugin reads no other tool's credentials.
  - `~/.devspec/` (`0600` / `0700`): per-connection state, recent session messages, recall state, commit tracking records, and local logs. Its `notes/` folder holds files handed to the agent to read (project rules, messages the plugin could not post, long room messages or recall records, and any read-retry status files).
  - `.devspec/project.json`: written in a repository only when you ask `/devspec-project` to remember a default project.

---

## Learn more

- **Website and sign-up:** [devspec.ai](https://devspec.ai)
- **Agent setup (connected tools):** [app.devspec.ai/settings/agents](https://app.devspec.ai/settings/agents)
- **Privacy policy:** [devspec.ai/privacy](https://devspec.ai/privacy)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

---

## Contributing and testing new versions

For contributors working on the plugin or testing unreleased changes:

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
- **Test a repository marketplace install.** Add this repository as a plugin marketplace with `cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin`, then install **devspec** from `/plugin`. Adding a marketplace does not install the plugin; installing it from `/plugin` is what loads it. A copy installed this way stays on the version you installed: to move on, run `cursor-agent plugin marketplace remove devspec`, add it again and reinstall. `cursor-agent plugin marketplace update` does not bring a newer version.
- **Resuming chats.** `cursor-agent --resume` works as usual; the plugin reports Cursor's conversation id to DevSpec as `local_session_id`. A chat without a Cursor conversation id is matched to a DevSpec connection only when exactly one live, attached Cursor connection is in the folder; with several, the plugin refuses rather than guess.
- **Context the hooks add.** Cursor passes on at most 10,000 characters from all the hooks that answer one step, this plugin's, other plugins' and your own together, and drops all of them when they run over. It keeps no record of what reached the agent: the agent transcript never holds hook context. So each of this plugin's hooks keeps to an equal share and puts anything longer in `~/.devspec/notes/`, split, between whole lines or whole characters, into parts that each fit what Cursor shows the agent from one shell command (20,000 characters, and 40,000 bytes before it moves the output to a file instead), and what must reach the agent (the project's rules, a message for you, unread room messages, a note about an untracked commit, a broken pin, a repository to link) is offered again after every step until the agent has read all of it. Each hand-over must be read on its own: rules that change and change back, a resumed chat and a compacted one are offered the rules again, and a note that cannot be read back is never dropped or replaced: the line pointing at it says so in a fixed number of characters, and which parts failed and how to retry are in a small status file beside it (`~/.devspec/notes/<id>.status.md`). When several notes wait at once, every line the plugin adds has a fixed largest size, notes the agent can read are listed before any that cannot, and room is kept first for the line counting them all, so the count always arrives. The full list of paths and the one rule they keep is at the top of `hooks/scripts/hook-context-budget.mjs`. Each part, and each page of room messages, closes with its own length and checksum, and counts as read only when the output that came back carries all of it, never because a command mentioned it or Cursor kept only its beginning and end. `hooks/scripts/hook-context-budget.mjs` has the measurements and the details.
- **Turn ends read from Cursor's transcript.** Cursor's command-line agent runs a plugin's own `stop` and `beforeSubmitPrompt` hooks only when the person also has a hooks file of their own, and never headless. Cursor's staff have confirmed this as a known bug ([173219](https://forum.cursor.com/t/cursor-cli-does-not-run-enterprise-or-team-beforesubmitprompt-hooks/173219), [177989](https://forum.cursor.com/t/cursor-cli-2026-11-05-macos-user-level-cursor-hooks-json-is-never-loaded-project-level-cursor-hooks-json-works/177989), [169059](https://forum.cursor.com/t/cursor-cli-omits-beforesubmitprompt-afteragentresponse-and-stop-hooks-loses-token-usage-and-emits-inconsistent-generation-id-values/169059)). The plugin never writes to a person's hooks file to get around it. Instead the remote-control poller notices each turn's end in the conversation's transcript and reports it as the `stop` hook would (`hooks/scripts/transcript-turn-end.mjs`, whose header has the details). Once Cursor runs plugin `stop` hooks without a user hooks file, in the terminal and headless, that fallback can be removed.
- **Tests.** Run them with `npm test`.

## License

[MIT](./LICENSE)
