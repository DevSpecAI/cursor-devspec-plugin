---
name: devspec.remote-stop
description: Disconnect DevSpec remote control for THIS conversation only — connection offline on the Agents page, stop the matching poller, leave other remotes alone.
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect **this** conversation's connection so the **Agents page** drops its live indicator immediately.

## Plugin root (non-negotiable)

Use the **installed Cursor DevSpec plugin** scripts only.

1. Prefer a prompt line `PLUGIN=<absolute-path>` when present (the launcher injects it).
2. Otherwise find it under `~/.cursor/plugins` (Windows: `%USERPROFILE%\.cursor\plugins`), taking the most recently modified match:

   ```bash
   HIT=$(find "$HOME/.cursor/plugins" -maxdepth 9 -path '*/hooks/scripts/remote-control-state.mjs' 2>/dev/null | head -1)
   PLUGIN=${HIT%/hooks/scripts/remote-control-state.mjs}
   ```
3. **Never** call `remote-control-state.mjs` from `~/.claude/plugins/**` or marketplace caches.
4. Quote `"$PLUGIN"` in every shell command.

## Multi-connection safety (non-negotiable)

Multiple remotes may run on one machine (several Cursor terminals).

- Stop **only** the target `connection_id`.
- **Never** kill every `devspec-remote-poll` process on the machine.
- **Never** offline any other connection.
- Prefer: `node "$PLUGIN/hooks/scripts/remote-control-state.mjs" disable --connection-id <uuid>` (connection-scoped disable + kill).

## Steps

1. **Resolve connection id** (in order):
   - Explicit arg / user-provided `connection_id`.
   - This conversation's state:
     ```bash
     node "$PLUGIN/hooks/scripts/remote-control-state.mjs" resolve-local \
       --agent "Cursor" --local-id "$CURSOR_CONVERSATION_ID"
     ```
     (use its `connection_id`).
   - `~/.devspec/remote-control/connections/<uuid>.json`, or legacy `~/.devspec/remote-control.json`.
   - If ambiguous, ask the user. Note its `session_id` (may be `null` = sessionless).

2. **Mark the connection offline (this connection only):** one path, attached or sessionless:
   ```
   devspec__heartbeat_connection({ connection_id, status: "offline", end_reason: "local_stop" })
   ```
   then optionally `devspec__detach_connection({ connection_id })`.
   **Do not** `devspec__post_session_message` disconnect chrome — presence updates via the offline heartbeat / Agents page.

3. **Disable local state + kill only this poller + mark bond stopped:**
   ```bash
   node "$PLUGIN/hooks/scripts/remote-control-state.mjs" disable \
     --connection-id '<connection_id>' --agent "Cursor" --local-id "$CURSOR_CONVERSATION_ID"
   ```
   Connection-scoped: writes that connection's state `enabled: false`, marks matching local bonds `stopped` (soft-reconnect only for this conversation within the recovery window), and SIGTERMs pollers whose argv includes this connection UUID only.

4. **Print in this local terminal only** (never into the session transcript):
   ```
   ✓ DevSpec remote control stopped
     Connection: {first 8}…
     Agents page: offline
     Other remotes on this machine: left running
   ```

## Rules

- Always offline **this** connection.
- Do not delete the DevSpec session — history remains.
- Soft-reconnect is bond-scoped (same conversation id), never by cwd/repo.
- Distinct from any built-in remote-control feature of your host app.
