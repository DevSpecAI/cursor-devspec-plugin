# Changelog

## 0.5.4 - 2026-08-13

> Maintainer note: `package.json` is in `protected_paths`, so this version bump is documented here only — bump `package.json` manually before publishing the new VSIX.

### Improved

- **Cold Connect first ping:** argv is now an imperative `devspec-remote-wait.mjs --from-end` command. The model must not read the stamp/skill before that Shell call. Full stamp stays on disk for recovery (item 1586a9e4). Keeps the e949305f argv-vs-stamp split (no YAML `---` on argv).
- **Wait argv path with spaces (Sprinting Ibis):** when the extension lives under `C:\Users\Brandon Young\…`, Connect wait argv now junctions the plugin to `%ProgramData%\DevSpec\cursor-plugin` so `node <script>` has no whitespace. Cursor TUI wrap was splitting the quoted path and the model dropped quotes (item dc3fb0f5). Stamp `PLUGIN=` is still the real extension path.
- **Poller after powershell-ps1 resume:** child-tree owner walk waits 15s (was 2.5s) and treats `cursor-agent.exe` as a durable CLI owner. Ibis died ~3 min after attach because ensure-poller timed out before the agent process appeared (item 833df74e). Still never pins to powershell, `launch-cli-session`, or `Cursor.exe`.
- **Poller owner-pid is `--resume`, never `worker-server`:** the first cursor-agent `node.exe` in the CLI tree can be `index.js worker-server`, which exits while `agent --resume` stays alive. That fired `owner_gone` with the terminal still looking fine (Copper Sparrow, Azure Bison, Azure Raccoon — item 5c884554). Walks skip worker-server; Cursor.exe / powershell / launch-cli-session refusals unchanged.

## 0.5.3 - 2026-08-13

### Fixed

- **First dispatch after mechanical Connect was skipped (Emerald Ocelot):** wait `--from-end` seeked to EOF, so `owner_messages` the poller had already written (join chip is live before the model arms wait) were never woken. `--from-end` still skips `advisory_context` history; unread owner commands in the inbox are kept (item 1f177af4).

## 0.5.2 - 2026-08-13

### Fixed

- **Windows mechanical Connect died before `--resume` (Restless Owl):** fast-connect ran `ensure-poller` from `launch-cli-session` *before* the CLI agent existed. The owner-pid walk starts at the launcher (explicitly ephemeral) and `cursor-agent` is not an ancestor yet, so poller spawn refused, the launcher exited 1, and the connection left with no heartbeats. Register/attach/write-state still run before resume (join chip + thin Live stamp). The poller starts after `agent --resume` is spawned, anchored to a durable host in that child tree (`cursor-agent` node.exe / `agent.exe` — not powershell, `launch-cli-session`, or `Cursor.exe` the IDE) (item f099fc6e).

## 0.5.0 - 2026-08-11

### Removed — the `DevSpec Autopilot:` commands are gone; staged batches arrive at any idle connection

**Migration:** if you used **DevSpec Autopilot: Process next staged item** (or its queue flags), stage the items in DevSpec instead (**Stage for Autopilot** / approve a plan) and keep a remote-control session idle — DevSpec hands the batch to it. Status is the Agents page; stop is **DevSpec: Disconnect remote control**; history is the assignment and item record.

- **The extension no longer chooses its own work.** The three autopilot palette commands and their skills are deleted, and with them the `get_next_work_item` self-selection path; the server routes a staged batch to a connection and the plugin only works what it was handed.
- **Unattended is a mode, not a command.** The dispatch-protocol section of `devspec.remote` (step 8a) and the poller's injected dispatch text now state the batch contract explicitly: batch rules override conversational rules for the duration of the batch, a member that cannot be done safely is failed loudly with `fail_work_item` (never stalled on a question nobody is there to answer), and the connection returns to ordinary available capacity when the batch resolves.
- The extension *id* (`devspec-autopilot`) and rules marker keep their names — they are install identity, not the command surface; renaming them would break upgrades for no functional gain.
- No replacement command or flag is created. Same deletion across the Claude Code, OpenCode, Grok, Antigravity and Codex plugins under the same item (`3f2f390c`).

## 0.4.15 - 2026-08-11

### Fixed

- **Cursor CLI Show work stays thin:** Agents interactive `--resume` often never fires mid-turn hooks from `~/.cursor/hooks.json`, so `trail-turn.mjs` never runs even though it works when invoked manually. On attached owner-command pickup the poller now starts `cli-trail-watch.mjs`, which tails the bonded agent-transcript JSONL and posts throttled `phase=trail` while the turn marker is alive (item 63f3db87). IDE hook path unchanged.

## 0.4.12 - 2026-08-11

### Fixed

- **Windows Cursor CLI poller idle_timeout (no `agent.exe`):** owner-pid ancestry walk now treats `node.exe` whose CommandLine hosts `cursor-agent` (e.g. `AppData\Local\cursor-agent\…\index.js`) as a durable host. Name-only matching (`Cursor.exe` / `agent.exe` / `claude.exe`) missed Cursor CLI attaches that run entirely under node — `ensure-poller` refused to start, heartbeats never fired, and the connection left with `idle_timeout` ~90s later (Calm Kingfisher / item c57dc381). Ephemeral plugin scripts (`remote-control-state`, poll/wait, `launch-cli-session`) stay rejected.

## 0.4.10 - 2026-08-10

### Fixed

- **Ship OpenCode serve `--auto` removal into installs:** source already dropped unsupported `serve --auto` (item `79a01caf`) while keeping `--auto` on `run`, but the installed `0.4.9` VSIX still had the old launcher. This release packages that fix so cold launches bind again and permission auto-approve stays on `run` only. Pair with OpenCode plugin `0.3.8` (`permission.ask` auto-allow while bonded) so later `promptAsync` remote turns do not hang (item `1514baa3`).

## 0.4.9 - 2026-08-04

### Fixed

- **Windows owner-pid flaps (`owner_gone`):** ancestry walk now stops on durable Cursor hosts (`Cursor.exe`, CLI `agent.exe`, still `claude.exe`), not only Claude. Explicit `--owner-pid` that names a short-lived tool shell (`powershell` / `pwsh` / `cmd` / `bash`) is ignored so self-resolve can climb to the real host — passing tool-shell `$PID` was ending the poller mid-session (item f3a88333).

## 0.4.8 - 2026-08-04

### Fixed

- **Cursor CLI Working spinner stuck after reply:** re-arm wait with `--pending --after-reply` after posting the answer so the turn marker clears and DevSpec drops Working/dots. Cursor CLI often never fires the IDE Stop hook; plain `--pending` correctly kept Working mid-turn (68f7b30c) but left it stuck forever after the reply (fe456bf9).
- **Mirror hooks survive VSIX bumps:** `~/.cursor/hooks.json` now points at stable `~/.cursor/devspec/hooks/run-mirror-turn.mjs`, which resolves the newest installed `devspecai.devspec-autopilot-*` extension each run (2097651e).

### Read a memory before superseding it — search now returns a card

DevSpec's `search_memories` changed today: it returns a **card** (title, one-line summary, id, state) instead of the full memory body, because a 15-result search was returning over 600,000 characters. The full text comes from a new `get_memory` tool.

- **The instruction that mattered was the supersede one.** This plugin told the agent to search memories first and supersede the closest match instead of duplicating — a judgement made against full bodies yesterday, and against one-line summaries today. It now says to `get_memory` the match and read it in full first: a card is enough to choose WHICH memory you mean, not enough to justify overwriting an entry in the team's shared decision record.
- **Where the autopilot loop treats memories as hard constraints**, it now reads the binding ones in full. A summary states the decision; the body carries the qualifications and exceptions, and a constraint obeyed without its exceptions is how an unattended loop confidently does the wrong thing.
- **No `allowed-tools:` gate here**, unlike the Claude Code plugin, so `get_memory` was already callable — this release is about the instructions, not about unblocking a refused tool call.

Nothing else needs reinstalling for the DevSpec-side change: MCP tool definitions come from the server, so a reconnect picks up the renamed `body` parameter and the now-required `title` on `record_memory`.

Item `93a851b5`.

## 0.4.7 - 2026-07-29

### Improved

- **Faster Cursor CLI cold attach:** protocol-handler / CLI launches now embed the Cursor `devspec.remote` skill body (in addition to the `PLUGIN=` pin from 0.4.6). Web cold-starts were spending ~1–2 minutes globbing for the skill and often landing on the Claude marketplace copy; the agent now gets the skill inline and can register/attach immediately.

## 0.4.6 - 2026-07-29

### Fixed

- **Cursor CLI / IDE session launch mislabel:** protocol-handler launches now inject `PLUGIN=<extension path>` into remote-control prompts (same pin command-palette paste already had). Without it, agents often ran Claude marketplace poller scripts and every heartbeat overwrote the connection as "Claude Code".

## 0.4.0 - 2026-07-25

### Remote control — long-poll transport, and the room arrives with the command

- **The polling interval is gone.** One held `poll_connection` call replaces the old three-call tick (`heartbeat_connection` + `get_connection_dispatch` + `get_session_transcript`). The server holds the request open (~25s) and answers the instant something lands: **~2 requests/min instead of 8, and ~0 delivery latency instead of up to 15s.** Fixed intervals survive only as error/empty-turn backoff.
- **Room context is now delivered WITH the command.** A wake payload begins with a labelled `room_context` event — `owner_ambient` (your owner talking in the room, but not to you) and `room_context` (teammates, Dev, other agents) — followed by the command last. Previously advisory was written to a side file and reading it was an instruction the model had to remember; an agent could hold "1", "2", "3" on disk and still fail to answer "what's the next number?". Because a long-poll returns the instant anything arrives, the poller carries advisory forward since the last command so it is genuinely there when the command lands.
- **Reconnect arrives oriented.** A cold launch or a server-side reattach asks for the bounded catch-up window, writes it as advisory and seeds the carry buffer — so the first command after reconnecting already has the room. Already-answered history is still filtered out of the commands, so reconnecting never re-wakes a finished turn.
- **Commands state their addressee.** Every delivered command carries `addressed_to` (agent name · codename · connection id) and an `authority` stamp, and the poller **refuses** anything not addressed to it. Two of your agents in one room can no longer be confused for each other, and a misroute is visible instead of silent.
- Teardown is faster: a held request is aborted the moment the owning agent process dies, and every request now has a hard client-side timeout, so a dropped network can no longer wedge a poller with no heartbeat.
- Also picks up the Windows owner-pid resolution the shared layer gained in the previous release.


## 0.3.16 - 2026-07-24

### Remote control — never drop owner mail that arrives mid-turn

- `devspec-remote-wait` **defaults to resuming from `inbox_byte_offset`** (not EOF).
- Skill: **re-arm with `--pending`** after every wake. `--from-end` is first-connect only.
- Live bug: re-arming with `--from-end` after a wake skipped owner commands the poller had already written while the agent was mid-turn.

## 0.3.15 - 2026-07-24

### Remote control — agent-canonical, connection-scoped, session optional

- **Answers:** when attached, post via `post_session_message({ connection_id })` (server resolves current session). Sessionless: assignment / `report_progress` only — never invent a room.
- **Stop hooks:** busy/heartbeat + optional local_prompt only — **no** full assistant mirror as primary path.
- **`devspec.work --remote`:** defaults **sessionless**; optional `--session` / `--new` for a transcript.
- Skills state a **single** delivery path (no “if hooks fail also post answers” dual).

## 0.3.14

### Fixed

- **Remote-control PLUGIN pin:** `devspec.remote` / `devspec.remote-stop` resolve scripts from the installed Cursor extension (`~/.cursor/extensions/devspecai.devspec-autopilot-*`) and forbid Claude marketplace caches. Command-palette paste injects absolute `PLUGIN=<extensionPath>` so Agent attach uses auth-smoke / `ensure-poller` instead of hunting wrong scripts.

## Unreleased

- **README:** full rewrite — intro, Before you start, VSIX install, one-token connect (**DevSpec: Set MCP token**, account-wide + retrievable), verify, and the preserved "Open in Cursor" protocol-handler section.
- **Cursor CLI launch flags:** interactive rocket CLI now defaults to `--force --approve-mcps` for work (YOLO + MCP), and `--plan --approve-mcps` for brainstorm (no YOLO). Mirrors DevSpecV2 headless/resume policy.
- **Cursor CLI true launch (`surface=cli`):** signed `devspec://` handoffs can open interactive Cursor CLI (`agent`) in a terminal instead of Cursor IDE. Handler resolves `agent` on PATH, mints a chat via `create-chat`, stamps `local_session_id` for Resume, and never falls back to opening the IDE when CLI is requested. Missing `agent` opens the DevSpec error page (`agent_missing`).
- **Agent-authoritative remote-control "working" state:** the connected agent now reports `busy:true` on turn start (plus a turn marker) and `busy:false` on turn end/interrupt; the long-lived poller re-asserts busy while a turn runs so long turns stay "working" and an interrupted turn decays instead of stranding a phantom "working". Poller backoff gains a `dormant` (~hourly) tier and the idle-disconnect lifetime extends from 24h to 72h.
- **Remote-control turn mirroring:** ship `hooks/scripts/mirror-turn.mjs` + poller suite; on activate, merge `UserPromptSubmit`/`beforeSubmitPrompt` + `Stop` hooks into `~/.cursor/hooks.json` so local prompts post literally (`turn_kind=local_prompt`) without model mediation. Command: **DevSpec: Install remote-control mirror hooks**.

## 0.3.4

### Added

- **`devspec.remote-stop`** — disconnect DevSpec remote control and clear the Agents-page live indicator.

## 0.3.3

### Added

- **`devspec.remote`** — connect this Cursor agent as a DevSpec remote-control target (private Agents-page channel). Command palette: **DevSpec: Connect remote control**. Distinct from Claude Code's built-in `/remote-control`.

## 0.3.0

### Changed — `devspec://` protocol handler replaces always-on localhost bridge

- **Windows / Linux:** extension activation registers `devspec://` (per-user, no admin). No background daemon or login startup entry.
- **macOS:** keeps signed localhost bridge on port 42731 until a signed `.app` helper ships.
- Rocket handoffs use **short-lived Ed25519-signed tokens** from DevSpec `/api/cursor-handoff/sign`.
- Manual install: `scripts/install-protocol-handler.cmd` (Windows) / `install-protocol-handler.sh` (Linux/macOS).

### Added

- `DevSpec: Install protocol handler` command palette entry.
- `scripts/open-handler.mjs` ephemeral handler (`--url` mode).
- Optional `npm run handler:build-exe` for `bin/devspec-open-handler.exe` (Node fallback in `devspec-handler.cmd` when exe is absent).

## 0.2.0

### Added — Claude plugin parity release

- **12 skills** with dot notation matching Claude (`devspec.work`, `devspec.brainstorm`, `devspec.create`, `devspec.session-brainstorm`, `devspec.verify-connection`, `devspec.done`, `devspec.help`, `devspec.link`, `devspec.commit`, `autopilot.process`, `autopilot.status`, `autopilot.history`).
- **7 new command-palette entries:** Create, Session brainstorm, Verify connection, Done, Help, Link, Commit.
- **`devspec.verify-connection` ping mode** (`verify_agent_connection`) for git-free onboarding checks.
- **`npm run sync`** script (`scripts/sync-from-claude.mjs`) to regenerate skills from the Claude plugin commands.

### Changed

- Skill instructions synced from Claude plugin: worktree isolation, project resolution via `list_projects`, `record_implementation` / `update_action_item` APIs, implementation quality standards, per-repo branch maps, merge-integrate protocol.
- Renamed skill folders from hyphenated (`devspec-work`) to dot notation (`devspec.work`).
- `autopilot.process` is one-shot (no background polling) — Cursor counterpart to a single Claude autopilot cycle, with `--items=` targeted batch support.

### Not ported (by design)

- `/autopilot:start` / `/autopilot:stop` background polling loop — use Claude Code for continuous autopilot.

## 0.1.4

### Added
- **`devspec-verify-connection` skill** — proves the setup connection loop end-to-end. Given the setup-wizard verification UUID, it reads the per-repo branch map from `devspec__get_project_summary`, finds locally-cloned target repos by matching the `origin` remote, pushes a `chore: verify DevSpec [devspec-verify:<id>]` empty commit to each repo's target branch (reporting `pushed` only on a successful push), reports repos it can't find locally as `skipped: not cloned locally`, and posts every per-repo outcome via `devspec__report_connection_check`. Distinct from item verification — it never touches action items.

> Maintainer note: `package.json` is in `protected_paths`, so this version bump is documented here only — bump `package.json` manually before publishing the new VSIX.

## 0.1.3

### Added
- **Targeted run mode** for `autopilot-process`. Pass `--items=<uuid1>,<uuid2>,...` to the command-palette prompt to process a fixed ordered list of action items in one invocation, then exit. UUIDs are validated up-front (`^[0-9a-f-]{36}$`) — invalid values abort the run before any MCP call so nothing partial gets claimed or heartbeated. The startup banner adds `mode: targeted (N items specified)` and `remaining: M` lines so it's clear at a glance the runner is processing a fixed list rather than the live queue. A 409 on any item skips to the next; the rest of the batch still runs. Default behaviour (no flag) is unchanged.
- `Optional flags` input prompt on the **DevSpec Autopilot: Process next queued item** command. Empty input runs default mode (next queued); typing `--items=...` switches to targeted mode. The placeholder shows the syntax inline.

> Maintainer note: `package.json` is in `protected_paths`, so this version bump is documented here only — bump `package.json` manually before publishing the new VSIX.

## 0.1.2

### Added
- Preflight MCP availability check in `devspec-work`, `devspec-brainstorm`, and `autopilot-process` skills. Each skill now calls `devspec__list_projects` before any other action and aborts with a clear message if the DevSpec MCP server isn't reachable from the chat thread. Prevents the silent fall-through where code shipped to staging without the action item being claimed or linked.
- README "Troubleshooting" section covering stale chat MCP state, the most common failure mode after changing extension settings.

## 0.1.1

### Fixed
- `devspec.apiUrl` no longer defaults to a non-existent prod host (`https://app.devspec.ai`). The default is now empty, and users are prompted for the URL on first connect — preventing the extension from clobbering an existing working `~/.cursor/mcp.json` entry.

## 0.1.0

### Added
- Cursor extension scaffold (VSIX) with TypeScript source, esbuild bundling, and `vsce` packaging.
- Five command-palette entries for DevSpec skills: `Work`, `Brainstorm`, `Autopilot Process / Status / History`. Each loads its `SKILL.md` prompt and copies it to the clipboard for pasting into Cursor chat.
- `DevSpec: Set MCP token` and `DevSpec: Register MCP server in Cursor config` utility commands.
- Auto-registration of the DevSpec MCP server in `~/.cursor/mcp.json` on activation when configured.
- Settings: `devspec.apiUrl`, `devspec.mcpToken` (machine-scoped).
