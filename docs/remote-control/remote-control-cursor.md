# Remote control — Cursor (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `cursor-devspec-plugin` (VSIX; hooks under `hooks/scripts/`).

## How a message reaches Cursor

1. Owner dispatches to this connection in DevSpec.
2. Detached `devspec-remote-poll.mjs` long-polls and writes the inbox.
3. `devspec-remote-wait.mjs` runs **one-shot** (no `--stream` in the Cursor plugin copy).
4. Wait exits on owner command; Cursor notifies the Agent chat on matching stdout.
5. Model acts; when attached, model `post_session_message({ connection_id, complete_turn: true })` on the **final** answer (omit `complete_turn` on mid-turn progress posts).
6. Model **must re-arm** wait with `--pending --after-reply` after the reply (never `--from-end` on re-arm) — backstop for Working clear + local turn marker.

## Why one-shot here

Cursor has no Claude-style persistent Monitor for session-scoped stdout wakes. Exit-to-notify is the working host pattern. That makes **re-arm mandatory**; forgetting it leaves the connection Live but deaf.

## Turn end / Working indicator

Working (dots / logo spinner) is driven by connection activity + busy, seeded by the per-connection `.turn` marker the poller writes on owner-command delivery.

| Path | When | Clears Working? |
|---|---|---|
| `post_session_message({ complete_turn: true })` | Final agent answer (same MCP request as the bubble) | Yes — **preferred**: activity complete + `busy:false` broadcast with the insert so phone/web clear when the answer lands (item d4014e58). Mid-turn progress posts omit the flag (item 5e7aac1c) |
| Stop hook → `mirror-turn.mjs stop` | IDE Agent turn end (when hooks fire) | Yes — clears marker **and** immediately `report_complete` + `busy:false` |
| Wait `--pending --after-reply` | After the model posts the reply and re-arms (Cursor skill) | Yes — **backstop on Cursor CLI** (Stop often never fires): clears marker **and** immediately `report_complete` + `busy:false` (item cd989606). Without `complete_turn` on the post, this is what ends Working (~agent overhead + MCP RTT after the bubble) |
| Wait plain `--pending` | Mid-turn re-arm only | **No** — keeps Working (item 68f7b30c) |
| Wait `--from-end` | First arm after connect | Yes — clears seed/phantom markers **and** immediately completes any leftover working attempt |
| `MAX_TURN_MS` (1h) | Poller backstop | Yes — last resort |

Do **not** clear Working on interim `post_session_message` alone (omit `complete_turn` — item 5e7aac1c). Do **not** clear on plain `--pending` re-arm.

**Why `complete_turn` on the final post:** ending Working only via wait `--after-reply` still leaves dots for several seconds after the answer bubble (post → agent re-arm → MCP complete). Ending in the same `post_session_message` request clears them with the bubble. Keep `--after-reply` as the backstop for clients that have not adopted the flag yet.

## Host specifics

| Topic | Cursor |
|---|---|
| Invoke remote | `devspec.remote` skill / Agent prompt (IDE) |
| Bond id | Prefer `CURSOR_CONVERSATION_ID` or explicit `--local-id`; shell often lacks it — do not silently mint then lose the bond |
| Token | This repo’s own `resolve-mcp-auth.mjs` — reads `~/.cursor/mcp.json` (not Claude plugin env) |
| Agent name | `AGENT_NAME = 'Cursor'` |
| Owner pid | Prefer omit or `"$PPID"`; on Windows the write path self-resolves up to `Cursor.exe` / CLI `agent.exe`. **Never** pass tool-shell `$PID` (`powershell` / `pwsh` / `cmd` / `bash`) — those exit when the tool call ends and fire `owner_gone` (item f3a88333). Invalid MSYS `$PPID` is ignored and self-resolved. |
| Mirror hooks | `~/.cursor/hooks.json` points at **stable** `~/.cursor/devspec/hooks/run-mirror-turn.mjs`, which resolves the newest installed VSIX each run (never pin a versioned extension path) |

## What not to change lightly

- Copying Claude’s `--stream` wait into Cursor — there is no Monitor primitive here, and no file crosses a repo boundary anyway.
- Overwriting Cursor’s auth resolver with Claude’s.
- Using `--from-end` after the first arm (drops pending inbox mail).
- Re-arming with plain `--pending` after a finished reply (leaves Live-but-Working forever on CLI).
- Hand-writing connection JSON with a hardcoded prod MCP URL.
- Pointing hooks.json at `…/extensions/devspecai.devspec-autopilot-<version>/…` (dies on every VSIX bump).

## Failure modes

- Missed re-arm after answering → next owner message never wakes.
- Final answer without `complete_turn: true` → dots linger ~agent overhead + MCP RTT after the bubble until `--after-reply` completes (d4014e58).
- Re-arm without `--after-reply` after a reply → Working/dots stuck if the post also omitted `complete_turn` (CLI).
- Re-arm with `--after-reply` that only clears the local marker (no `report_complete`) → dots linger one long-poll (~30s) after the reply — fixed by `notifyWorkingEnded` in wait (cd989606).
- Stale notifications from a previous wait process → check whether the command was already answered before redoing work.
- Wrong local_id mint vs conversation id → duplicate connections / Resume empty.
- Tool-shell `$PID` as `--owner-pid` on Windows → poller dies with `owner_gone` mid-session; reconnect without bond revival used to mint a new connection and orphan targeted dispatches.
- Version-pinned hook path → Stop never runs; Working and local-prompt mirroring go silent.

## Key files

- `hooks/scripts/devspec-remote-poll.mjs`
- `hooks/scripts/devspec-remote-wait.mjs` (one-shot; `--after-reply` turn-end)
- `hooks/scripts/run-mirror-turn.mjs` (stable hook launcher)
- `hooks/scripts/mirror-turn.mjs` (Stop / user_prompt)
- `hooks/scripts/remote-control-state.mjs`
- `hooks/scripts/resolve-mcp-auth.mjs` (**plugin-owned**)
- `hooks/scripts/agent-identity.mjs`

## Logging — reconstructing a connection story

Fragile remote sessions are debugged from two places that share one phase vocabulary:

| Source | Where | What |
|---|---|---|
| **Axiom (server)** | DevSpec MCP tool logs | `msg == "Remote-control story"` with `connectionId`, `sessionId`, `data.phase`, `data.outcome`, `reason` |
| **Local poll.log** | `~/.devspec/remote-control/connections/<connection_id>.poll.log` | Poller stderr/stdout (spawn redirect). Structured lines prefixed `story ` plus human poller messages. Kept for offline debug. |

**Shared phases:** `register` · `attach` · `seed_filter` · `inject` · `wake` · `mirror_decision` · `mirror_post` · `complete_turn` · `pickup` · `done` · `poll_error` · `stall` · `ended`

Cursor emits client-side stories from `devspec-remote-poll.mjs` (seed filter, inject/wake, poll errors, max-turn stall) and `mirror-turn.mjs stop` (`complete_turn`). The agent’s `post_session_message` path is covered by server breadcrumbs after staging deploy.

**Axiom recipe** (dataset `devspec`):

```
['devspec']
| where msg == "Remote-control story"
| where connectionId == "<connection-uuid>"
| sort by _time asc
| project _time, ['data.phase'], ['data.outcome'], reason, sessionId, ['data.agent'], ['data.tool']
```

**Local recipe:** open the connection’s `.poll.log` and grep `story `. Do not dump model token streams into either log.
