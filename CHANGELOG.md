# Changelog

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
