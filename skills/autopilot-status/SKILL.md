---
name: autopilot-status
description: Display the current DevSpec autopilot status panel — queue counts, in-progress items, push/merge settings, and runner online/offline state. Use when the user asks about autopilot status, queue state, or how many items are pending.
---

# DevSpec Autopilot — Status

Read-only skill. Fetches autopilot configuration and queue state from DevSpec in parallel, then renders a compact status panel. No git operations, no writes, no side effects.

The DevSpec MCP server is registered as `devspec` in `mcp.json`, so all MCP tool names are prefixed `devspec__`.

---

## Step 1 — Fetch Data (in parallel)

Issue all three MCP calls in parallel (single tool-use batch — do not sequence them):

1. **`devspec__get_project_summary`** (no params) — read autopilot configuration from `local_plugin_settings`:
   - `auto_push` (boolean)
   - `auto_merge` (boolean)
   - `target_branch` (string, may be empty)
   - `branch_prefix` (string)

2. **`devspec__get_action_items`** with `agent_status: "queued"`, `agent_ready: true`, `limit: 100` — count returned rows as `queued_count`.

3. **`devspec__get_action_items`** with `agent_status: "in_progress"`, `limit: 100` — count returned rows as `in_progress_count`.

Run all three simultaneously — do not serialize. If any individual call fails, record `null` for that source and proceed; Step 3 shows `unavailable` in the affected row rather than aborting the whole panel.

---

## Step 2 — Determine Online/Offline

Heuristic (the skill has no direct heartbeat API — it infers liveness from the `in_progress` count):

- **ONLINE**: if `in_progress_count > 0` (a runner is actively processing at least one item, implying at least one recent heartbeat).
- **OFFLINE**: otherwise.

If `devspec__get_action_items` for `in_progress` failed, show `UNKNOWN` for the runner status rather than guessing.

---

## Step 3 — Render Status Panel

Output this compact Unicode banner exactly. Substitute real values; show `unavailable` for any field whose underlying call failed.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  runner    {ONLINE | OFFLINE | UNKNOWN}
  queued    {queued_count} items
  active    {in_progress_count} in progress
  push      {on | off}
  merge     {on | off}
  target    {target_branch or "(starting branch)"}
  prefix    {branch_prefix}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Field conventions:
- `push` / `merge`: `on` for `true`, `off` for `false`, `unavailable` on failure.
- `target`: show the `target_branch` value. If empty string, show `(starting branch)` to signal that it falls back to the runner's starting branch.
- `prefix`: show the `branch_prefix` value verbatim.

---

## Key Details

- **Read-only.** No git operations, no file writes, no MCP calls that mutate state (no `claim_work_item`, no `update_action_item`, no `fail_work_item`).
- **Parallel MCP calls.** The three fetch calls in Step 1 are independent; issue them simultaneously to minimize panel render latency.
- **Graceful degradation.** If any single call fails, show `unavailable` for the fields it would have populated rather than failing the whole panel. Users still see whatever data did succeed.
- **Cursor MCP prefix.** Tools are called as `devspec__get_project_summary`, `devspec__get_action_items`, etc. The `devspec__` prefix reflects the MCP server name registered in `mcp.json`.
- **Auto-discovered.** Cursor finds this skill automatically via the `skills/` directory convention. No explicit path registration needed in `.cursor-plugin/plugin.json`.
