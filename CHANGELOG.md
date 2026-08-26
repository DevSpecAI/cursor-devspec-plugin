# Changelog

## 0.10.0

### Fix: host wake-follow must not restart with `--from-end` on inject

`ensureWakeFollowForConnection` now reuses a live follow instead of
kill→respawn. Cold first-arm still uses `--from-end --follow`; recovery uses
`--pending --follow`. Stops Racing Turtle empty wake files when the poller
ensured follow immediately before `deliverOwnerMessages` (item 1badd088).

### Shared session plans stay connection-bound and survive Cursor reconnects

Cursor's remote poller now negotiates canonical ingress, delegated project scope,
and active-plan projection version 1 together. It strictly accepts the 1.3.0
active-session-plan inventory while preserving older strict parser tiers. Every
active plan in the attached room is available as advisory read awareness; the
projection never grants mutation authority.

Mechanical register negotiates a hidden per-connection capability. The trusted
helper captures MCP result `_meta`, stores the capability in a mode-0600
connection file, rotates it on reconnect, clears it on end, and sends it only in
the capability header for `manage_plan`. The raw value is never printed or put in
the global Cursor MCP configuration. `manage-plan describe` exposes the complete,
bounded schema only on demand; `manage-plan use` accepts plan mechanics on stdin
and derives identity from Cursor host state. Manual chats without a Cursor
conversation id use the minted-bond index only when one live attached candidate in
the current workspace is unambiguous; sibling candidates fail closed.

Static Cursor guidance now points plan timing to
`devspec://product/implementation-contract` instead of copying complexity-based
tracking rules. Routine work remains no-plan; qualifying plans use atomic advance,
authoritative revisions on reconnect, explicit plan id plus expected revision for
same-owner cross-plan work/adoption, and read-only treatment for other owners.
Cursor's native `agent --resume` and `local_session_id` behavior is unchanged.

> Maintainer note: Cursor releases are versioned independently from sibling host
> plugins. The Cursor plugin manifest is 0.10.0. `package.json` remains protected
> at 0.8.0 in source; bump it to 0.10.0 only as part of the signed VSIX/Open VSX
> publish step.

## 0.9.0

### Present commit references are confirmed without breaking offline work

A directly readable commit that already contains one well-formed DevSpec
reference now uses the purpose-built `validate_commit_reference` MCP tool. Only
a definitive `not_found` result refuses that commit; missing credentials,
timeouts, transport/auth/server failures, malformed responses, and uncertain
project resolution all allow. Unreferenced and newly auto-stamped commits make
no network call.

Linked worktrees now inherit untracked project `.cursor/mcp.json` and
`.mcp.json` credentials from the repository's main checkout, preserving their
paired endpoint and token ahead of home fallbacks. Alternate or multiple Git
message sources remain unreadable and pass untouched. The stable provenance
launcher also kills hung children after 10 seconds, discards partial output,
and exits successfully so Cursor's 30-second outer hook never becomes a local
work blocker.

### Commit provenance replaces mutation classification

Cursor no longer denies edits, tests, builds, arbitrary shell, worktrees,
delegation, or follow-through because a conversation has no active DevSpec
claim. The shell allowlist, repository-scoped mutation authority, and
post-edit stop response are removed rather than retained behind exceptions.

Cursor's structured `preToolUse` hook now assists only on directly readable,
quoted `git commit -m` messages in explicitly pinned projects. A valid full
DevSpec reference passes without a live claim; exactly one observed claim may
be appended with `updated_input`; multiple claims are never guessed. The
readable worktree shapes include both `cd <single-path> && git commit …` and
`git -C <path> commit …`. Opaque/history-producing forms and pushes fail open
to commit ingestion and analyzer recovery.

`afterFileEdit` has no supported response fields, so the optional one-time edit
reminder uses `postToolUse.additional_context` and says plainly that the edit
already happened. Existing remote control, trail delivery, session fallback,
permissions, and security controls are unchanged. Reload/reinstall the
extension to replace stale user-level mutation hooks.

> Maintainer note: `package.json` is protected and remains at 0.8.0 in source;
> bump it to 0.9.0 only as part of the signed VSIX/Open VSX publish step.

## 0.8.1

### Healthy turn close no longer looks like the agent crashed

The keep-alive poller called `report_complete` with no reason when the turn
marker cleared after a real reply. Staging treats a missing reason as an
old-poller stall and stamps the red "stopped before finishing this turn"
notice onto the leftover Working bubble. Healthy complete now sends
`reason: turn_end` (server skips abandon); a real max-turn stall still sends
`max_turn_ms`. Reload/reinstall the plugin after this lands.

### MCP HTTP calls no longer hang forever

Wait, mirror-turn, and `report_complete` used fetch with no timeout. A dead
gateway (HTTP 502 before `/api/mcp` logged) froze the poller and left DevSpec
showing Working for the rest of the hour. Non-hold MCP calls now default to 30s;
stall complete sends `reason: max_turn_ms` so the server can close the streaming
bubble.

Reload/reinstall the plugin after this lands. Source 0.8.0 already had the
resume-first owner-pid fix; machines still on 0.5.3 need this install, not a
reconnect of a hung session.

> Maintainer note: `package.json` is in `protected_paths`, so this version bump is documented here only — bump `package.json` manually before publishing the new VSIX.

## 0.8.0

### Cursor CLI Connect stays Live when the wait script is named in the prompt

Agents Connect puts `devspec-remote-wait` in the `--approve-mcps` prompt of the
durable `cursor-agent --resume` process. The Windows owner-pid walk treated any
command line containing that name as a throwaway helper, so the keep-alive
poller never started and DevSpec idle-timeout-disconnected the agent. `--resume`
hosts are durable even when later argv mentions plugin scripts; plugin scripts
and `worker-server` stay rejected.

### Nine skills removed — remote and remote-stop remain

`devspec.work`, `.create`, `.commit`, `.link`, `.help`, `.done`, `.brainstorm`,
`.session-brainstorm` and `.verify-connection` are gone from the command palette
and from `contributes.commands`.

A command must be a script, not a restatement. Connecting runs a deterministic
setup a model improvises badly; the other nine were a page of prose each,
telling a model to call one DevSpec MCP tool it could already see.

**Nothing was lost.** What those skills taught now lives in the MCP tool schemas
server-side, written once and reaching every host the moment it changes, instead
of copied into six repositories with no way to notice when one drifts.

**What you do instead is say it** in the Agent chat: *"Work on DevSpec action
item 4f2a"*, *"Work these in order: 4f2a, 9c1b, 2e7d"*, *"Log a DevSpec item for
the login bug"*. DevSpec's copy buttons emit exactly those lines, so copying and
typing produce the same thing — and a sentence works in any host with the MCP
server, which a palette command never could.

**`--plan` is gone with it.** `devspec.brainstorm` was the only route from
DevSpec to Cursor's plan mode, so `inferCursorAgentRunKindFromPrompt` no longer
returns a `brainstorm` kind; a stale prompt now reads as `work`. If plan mode is
wanted it should return as a deliberate feature, not as a leftover.

## 0.7.0 - 2026-08-17

### An agent reserves its work — nothing is dispatched to it any more

The server retired `get_assignment`, `acknowledge_assignment` and `resolve_assignment`, along with `get_next_work_item` (DevSpec item 1e455001). Nothing dispatches work to an agent, so there was nothing left for them to do: no batch to receive, no receipt to give, nothing to close.

One verb replaces them. **`reserve_work_items({ action_item_ids, connection_id })`** holds the ordered set you are about to work so no other agent takes one mid-run; then `claim_work_item` per item as you reach it. The batch closes itself when its last member is recorded, failed or released.

**`devspec.work` now reserves up front when handed several ids.** It has received one multi-id command since the multi-select work landed, while claiming them one at a time — so another agent could take the last id while it was still on the first.

**Read `skipped`.** An item another agent already holds comes back with a reason naming the holder rather than failing the call. Reporting the batch as yours anyway is how an owner ends up believing work is in progress that nobody has.

### Only the agent holding an item can release or fail it

`release_work_item` and `fail_work_item` had no ownership check at all, and `claim_work_item`'s compared USERS — which cannot tell two of your own agents apart, because a DevSpec token is account-wide. On 2026-08-16 a sibling connection released work another agent was actively on, leaving the item unclaimed while its reservation still said claimed.

All three now check the reservation against the `connection_id` you pass, server-side, so pass it. A stale hold is still always releasable with `force` and a reason — recorded as a takeover naming who did it, rather than reading like the holder handing work back.

## 0.6.0 - 2026-08-17

### `--unattended` is gone, and nothing replaced it

`devspec.work` took a flag that installed a mode for the whole session: never ask, never wait, auto-select the highest-priority match when a name was ambiguous. It read as a safety feature and was really a licence to guess.

Deleted: the flag, the `Mode:` line in the item header, every "interactive mode / unattended mode" fork, the batch-mode paragraph the poller injected into a dispatched assignment, and the two mode-specific contract resources — the served contract is now one document at `devspec://product/implementation-contract`. `devspec.remote`'s "batch mode overrides conversation mode" section goes too: working a batch never installed different rules, so resolving one clears nothing.

Nothing takes its place — no timeout, no patience window, no ask-policy. **Ask only what is not yours to decide** (never a detail the item's intent and criteria already settle), and **do not assume someone is waiting to answer** (before a claim, say what you need and stop; after a claim, fail the item with a precise reason).

Brainstorm no longer asks whether you want it: it runs when the invocation asked for it, and a plain work run skips it.

## 0.5.5 - 2026-08-14

### A quiet connection stays up while the host process is alive

- **Removed the 72h idle-disconnect.** The poller no longer stamps `idle_timeout` and exits after three quiet days. A connection lives as long as its Cursor process, unless you End it or run the remote-stop command. Item `4a74d001`.

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
