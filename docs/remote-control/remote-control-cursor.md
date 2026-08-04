# Remote control — Cursor (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `cursor-devspec-plugin` (VSIX; hooks under `hooks/scripts/`).

## How a message reaches Cursor

1. Owner dispatches to this connection in DevSpec.
2. Detached `devspec-remote-poll.mjs` long-polls and writes the inbox.
3. `devspec-remote-wait.mjs` runs **one-shot** (no `--stream` in the Cursor plugin copy).
4. Wait exits on owner command; Cursor notifies the Agent chat on matching stdout.
5. Model acts; when attached, model `post_session_message({ connection_id })`.
6. Model **must re-arm** wait with `--pending --after-reply` after the reply (never `--from-end` on re-arm).

## Why one-shot here

Cursor has no Claude-style persistent Monitor for session-scoped stdout wakes. Exit-to-notify is the working host pattern. That makes **re-arm mandatory**; forgetting it leaves the connection Live but deaf.

## Turn end / Working indicator

Working (dots / logo spinner) is driven by the per-connection `.turn` marker the poller writes on owner-command delivery.

| Path | When | Clears Working? |
|---|---|---|
| Stop hook → `mirror-turn.mjs stop` | IDE Agent turn end (when hooks fire) | Yes — primary when available |
| Wait `--pending --after-reply` | After the model posts the reply and re-arms (Cursor skill) | Yes — **required on Cursor CLI** (Stop often never fires) |
| Wait plain `--pending` | Mid-turn re-arm only | **No** — keeps Working (item 68f7b30c) |
| Wait `--from-end` | First arm after connect | Yes — clears seed/phantom markers |
| `MAX_TURN_MS` (1h) | Poller backstop | Yes — last resort |

Do **not** clear Working on interim `post_session_message` alone (server preserves busy until turn end — item 5e7aac1c). Do **not** clear on plain `--pending` re-arm.

## Host specifics

| Topic | Cursor |
|---|---|
| Invoke remote | `devspec.remote` skill / Agent prompt (IDE) |
| Bond id | Prefer `CURSOR_CONVERSATION_ID` or explicit `--local-id`; shell often lacks it — do not silently mint then lose the bond |
| Token | **Owns** `resolve-mcp-auth.mjs` — reads `~/.cursor/mcp.json` (not Claude plugin env) |
| Agent name | `AGENT_NAME = 'Cursor'` |
| Owner pid | Pass real Win32/parent pid into state write; invalid MSYS `$PPID` is ignored and self-resolved |
| Mirror hooks | `~/.cursor/hooks.json` points at **stable** `~/.cursor/devspec/hooks/run-mirror-turn.mjs`, which resolves the newest installed VSIX each run (never pin a versioned extension path) |

## What not to change lightly

- Syncing Claude’s `--stream` wait into Cursor without a Monitor primitive.
- Overwriting Cursor’s auth resolver with Claude’s.
- Using `--from-end` after the first arm (drops pending inbox mail).
- Re-arming with plain `--pending` after a finished reply (leaves Live-but-Working forever on CLI).
- Hand-writing connection JSON with a hardcoded prod MCP URL.
- Pointing hooks.json at `…/extensions/devspecai.devspec-autopilot-<version>/…` (dies on every VSIX bump).

## Failure modes

- Missed re-arm after answering → next owner message never wakes.
- Re-arm without `--after-reply` after a reply → Working/dots stuck (CLI).
- Stale notifications from a previous wait process → check whether the command was already answered before redoing work.
- Wrong local_id mint vs conversation id → duplicate connections / Resume empty.
- Version-pinned hook path → Stop never runs; Working and local-prompt mirroring go silent.

## Key files

- `hooks/scripts/devspec-remote-poll.mjs`
- `hooks/scripts/devspec-remote-wait.mjs` (one-shot; `--after-reply` turn-end)
- `hooks/scripts/run-mirror-turn.mjs` (stable hook launcher)
- `hooks/scripts/mirror-turn.mjs` (Stop / user_prompt)
- `hooks/scripts/remote-control-state.mjs`
- `hooks/scripts/resolve-mcp-auth.mjs` (**plugin-owned**)
- `hooks/scripts/agent-identity.mjs`
