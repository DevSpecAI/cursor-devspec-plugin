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
6. Model **must re-arm** wait with `--pending` after every wake (never `--from-end` on re-arm).

## Why one-shot here

Cursor has no Claude-style persistent Monitor for session-scoped stdout wakes. Exit-to-notify is the working host pattern. That makes **re-arm mandatory**; forgetting it leaves the connection Live but deaf.

## Host specifics

| Topic | Cursor |
|---|---|
| Invoke remote | `devspec.remote` skill / Agent prompt (IDE) |
| Bond id | Prefer `CURSOR_CONVERSATION_ID` or explicit `--local-id`; shell often lacks it — do not silently mint then lose the bond |
| Token | **Owns** `resolve-mcp-auth.mjs` — reads `~/.cursor/mcp.json` (not Claude plugin env) |
| Agent name | `AGENT_NAME = 'Cursor'` |
| Owner pid | Pass real Win32/parent pid into state write; invalid MSYS `$PPID` is ignored and self-resolved |

## What not to change lightly

- Syncing Claude’s `--stream` wait into Cursor without a Monitor primitive.
- Overwriting Cursor’s auth resolver with Claude’s.
- Using `--from-end` after the first arm (drops pending inbox mail).
- Hand-writing connection JSON with a hardcoded prod MCP URL.

## Failure modes

- Missed re-arm after answering → next owner message never wakes.
- Stale notifications from a previous wait process → check whether the command was already answered before redoing work.
- Wrong local_id mint vs conversation id → duplicate connections / Resume empty.

## Key files

- `hooks/scripts/devspec-remote-poll.mjs`
- `hooks/scripts/devspec-remote-wait.mjs` (one-shot)
- `hooks/scripts/remote-control-state.mjs`
- `hooks/scripts/resolve-mcp-auth.mjs` (**plugin-owned**)
- `hooks/scripts/agent-identity.mjs`
