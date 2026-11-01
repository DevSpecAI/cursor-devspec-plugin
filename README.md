# DevSpec for Cursor

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge and your coding agents build software together.

This plugin connects Cursor's command-line agent (`cursor-agent`) to your DevSpec projects. The agent can work your team's tasks with the project's decisions and documents to hand, record what it did, and take instructions from DevSpec in your browser or on your phone.

> **Command line only, for now.** The plugin is for Cursor's command-line agent. The Cursor editor isn't supported yet.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What it does for you

- **Work a task in chat.** Point the agent at a DevSpec task and it makes the change, runs your project's tests, commits, and records what it did on the task.
- **Work a batch in one go.** Say *"Work these DevSpec tasks in order: 4f2a, 9c1b, 2e7d"*. The agent reserves them so nobody else picks one up mid-run, then works them one at a time.
- **Steer it from DevSpec.** Put a `cursor-agent` conversation on your project's **Agents** page, send it work from your browser or phone, and follow along live in a DevSpec session.
- **Your team's knowledge in chat.** Ask about tasks, decisions, documents and reviews in plain words (*"What did we decide about caching?"*, *"Create a task for the login redirect bug"*).
- **Commits linked to tasks.** Commits the agent makes are reported to DevSpec and tagged with the task they belong to. See [Commit tracking](#commit-tracking).

---

## Requirements

- **Cursor's command-line agent**, `cursor-agent` (Cursor also installs it as `agent`). Install it from [Cursor's CLI installation page](https://cursor.com/docs/cli/installation), then check it in a new terminal with `cursor-agent --version`.
- **A [DevSpec](https://devspec.ai) account** with a project. When the project is linked to your git repository, the plugin finds it for you.
- **A DevSpec token.** On DevSpec's [Agent setup page](https://app.devspec.ai/settings/agents), choose **Create your token** with **Read & write** access. It starts with `dvs_`. You can use the same token in every tool and on every machine, and reveal it again on the same page at any time.
- **Node.js 18 or later** (`node --version`; install it from [nodejs.org](https://nodejs.org/en/download) if needed) and **git**.

---

## Install from the Cursor Marketplace

### 1. Install the plugin

1. Start `cursor-agent` and type `/plugin`.
2. Open the marketplace, search for **DevSpec**, and install it **for your user** rather than for a single project. A user install works in every folder, and it is where Cursor lets you set the token in the next step.

You can also add DevSpec from its page in the [Cursor Marketplace](https://cursor.com/marketplace) with **Add to Cursor**, then set your token as below.

### 2. Set your DevSpec token in the plugin's settings

1. In `cursor-agent`, type `/plugin`, open **DevSpec** in your installed plugins, and choose **Configure variables**.
2. Paste your token into **DevSpec token** and save. Leave **DevSpec API URL (advanced)** as it is.
3. Restart `cursor-agent`.

This connects the agent to DevSpec's tools.

### 3. Give remote control and commit tracking the token too

Remote control from DevSpec and commit tracking run in the background, outside the chat, and Cursor doesn't share plugin settings with them. They read your token from Cursor's MCP settings file instead: `~/.cursor/mcp.json` on macOS and Linux, `%USERPROFILE%\.cursor\mcp.json` on Windows. Open it in a text editor and merge in this entry, keeping any servers already there:

```json
{
  "mcpServers": {
    "devspec": {
      "url": "https://api.devspec.ai/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection",
      "headers": {
        "Authorization": "Bearer dvs_your_token_here"
      }
    }
  }
}
```

On macOS and Linux, make the file readable only by you:

```bash
chmod 600 ~/.cursor/mcp.json
```

Then restart `cursor-agent`. If you only want DevSpec's tools in chat, you can skip this step.

---

## Check it works

1. Start `cursor-agent` in your project's folder.
2. Ask: *"Check my DevSpec connection."* The agent checks with DevSpec and tells you which DevSpec account it is connected as.
3. Type `/devspec-remote`. The conversation appears on your project's **Agents** page in DevSpec, ready to take work from your browser or phone.

If DevSpec's tools are missing, type `/mcp` to see whether Cursor could reach DevSpec, then check your token and restart `cursor-agent`.

---

## Updates

You don't need to do anything. Cursor reviews each new release of the plugin before it reaches you and then updates your installed copy. Restart `cursor-agent` to start using a new release straight away. What changed in each release is in [CHANGELOG.md](./CHANGELOG.md).

### Coming from `devspec-autopilot`

The plugin used to be called **devspec-autopilot**, and it was installed straight from GitHub. That copy will not update to the renamed plugin. Remove it, then install DevSpec as above:

1. In `cursor-agent`, type `/plugin` and uninstall **devspec-autopilot**.
2. Remove its marketplace:

   ```bash
   cursor-agent plugin marketplace remove devspec-autopilot
   ```

3. Install **DevSpec** from the Cursor Marketplace and set your token (steps 1 and 2 above). An existing `devspec` entry in `~/.cursor/mcp.json` keeps working, so step 3 is already done. If that entry has an `x-devspec-plugin` line, delete the line: it names the old plugin's version.

---

## Commands

You can ask the agent to do anything in DevSpec in plain words (*"Work on DevSpec task 4f2a"*). The plugin also adds these slash commands to `cursor-agent`:

| Command | What it does |
|---|---|
| `/devspec-remote` | Puts this conversation on your project's **Agents** page, ready to take work from your browser or phone. |
| `/devspec-remote --new` | Connects and starts a new DevSpec session for this conversation, shared with the project. Add `--private` to make it visible only to you. |
| `/devspec-remote --session <id>` | Connects and joins an existing DevSpec session. |
| `/devspec-remote --project "<name>"` | Connects to that project for this conversation only, without changing the folder's default. |
| `/devspec-remote-stop` | Disconnects this conversation from DevSpec, leaving other `cursor-agent` conversations connected. |
| `/devspec-project` | Shows this conversation's project, chooses another one, or remembers or forgets a default project for the folder. |
| `/devspec-debug` | Collects diagnostics on your machine when you ask it to while looking into a problem. Nothing is uploaded unless you ask. |

## Choosing a project

`/devspec-remote` finds your project by itself when your repository's `origin` belongs to one DevSpec project you can access, or when the folder has a `.devspec/project.json` file naming the project.

When the agent can't tell which project you mean, it asks you. Use `/devspec-project` to see which project this conversation uses, to remember a default for the folder (saved in `.devspec/project.json`, which you can commit for your team), or to forget it. Moving to a different project needs a fresh conversation, and the agent gives you the command to start one, so nothing from one project carries over into another.

If you attach the agent to a DevSpec session that has a shared plan, it picks the plan up where it left off after it reconnects.

---

## Commit tracking

While a conversation is connected to DevSpec, the plugin notices each commit the agent makes with `git commit` and tells DevSpec which agent made it, so the work is credited to Cursor and linked to the right task.

- **macOS, Linux and WSL get full commit tracking.** Each command the agent runs starts with one added line that puts a private stand-in for `git` first on its `PATH`. The stand-in runs your real git unchanged and learns from git itself whether a commit was made, so a commit is noticed however it was made: a multi-line message, a message file, a script, `git -C`, a linked worktree or an alias. Nothing is installed in your repositories, and your git configuration and git hooks are not changed. Cursor's permission prompts and allow-lists check the same commands as before, though a prompt shows the added line above the command.
- **Task references are added for the agent.** In your project's repositories (one whose `origin` is a repository of the project, or that a `.devspec/project.json` pin names), when exactly one task is claimed, that task's `[devspec:<id>]` reference is added to the end of the commit's subject line before git runs, and the agent is told. With no task claimed, or several, a commit without a reference is stopped before anything changes, and the agent is told how to recover. Amends, fixups, reused messages and messages that already have a reference are left as written.
- **Other repositories are left alone.** Commits in a repository that is not one of the project's are not changed and are not reported.
- **What it can't see.** A git run by its full path (such as `/usr/bin/git`) or with a cleared `PATH` bypasses the stand-in, and commits git makes while merging, rebasing or cherry-picking are not reported; DevSpec still links any commit through the task reference in its message.
- **Nothing is lost quietly.** A report that can't be sent is tried again later, and what happened to each commit is written to `~/.devspec/remote-control/connections/<connection>.commits.log`.
- **Native Windows is limited.** Cursor runs commands there in PowerShell, which can't take the added line, so only straightforward `git commit` commands that the agent runs directly are noticed and tagged. Use WSL for full commit tracking.

---

## Install straight from GitHub (fallback)

Use this only if you can't install from the Cursor Marketplace. **Cursor does not update a plugin installed this way:** it stays on the version you installed until you remove it and add it again.

1. Add this repository as a plugin marketplace:

   ```bash
   cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin
   ```

2. Start `cursor-agent`, type `/plugin`, and install **devspec** from the marketplace you just added. Adding a marketplace does not install the plugin; installing it from `/plugin` is what loads the plugin.
3. Cursor doesn't offer plugin settings for a plugin installed this way, so add your token to `~/.cursor/mcp.json` as in [step 3](#3-give-remote-control-and-commit-tracking-the-token-too). That entry also connects DevSpec's tools.
4. Restart `cursor-agent`.

To move to a newer version, remove the marketplace, add it again, and install **devspec** again from `/plugin`. `cursor-agent plugin marketplace update` does not bring a newer version of the plugin.

```bash
cursor-agent plugin marketplace remove devspec
cursor-agent plugin marketplace add https://github.com/DevSpecAI/cursor-devspec-plugin
```

---

## Contributing

For working on the plugin itself:

- Run a checkout directly with `cursor-agent --plugin-dir <path-to-checkout>`; set `DEVSPEC_MCP_TOKEN` (and `DEVSPEC_API_URL` to point at another DevSpec environment) in the environment you start it from.
- `node scripts/setup-cursor.mjs` writes or refreshes the `devspec` entry in `~/.cursor/mcp.json`. It reads the token from `DEVSPEC_MCP_TOKEN`, standard input or `~/.devspec/auth.json`, never from the command line, and never prints it.
- `cursor-agent --resume` works as usual; the plugin reports Cursor's conversation id to DevSpec as `local_session_id`. A chat without a Cursor conversation id is matched to a DevSpec connection only when exactly one live, attached Cursor connection is in the folder; with several, the plugin refuses rather than guess.
- Run the tests with `npm test`.

Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
