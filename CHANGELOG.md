# Changelog

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
