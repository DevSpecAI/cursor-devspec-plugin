---
name: autopilot-history
description: Display the execution history of DevSpec autopilot runs — completed and failed items with timestamps, branches, merge status, and error messages. Use when the user asks about autopilot history, what was processed, or past runs.
---

# DevSpec Autopilot — History

Read-only skill. Fetches completed and failed autopilot items from DevSpec in parallel, sorts by claim time, and renders a compact timeline. No git operations, no writes, no side effects.

The DevSpec MCP server is registered as `devspec` in `mcp.json`, so all MCP tool names are prefixed `devspec__`.

---

## Step 1 — Fetch Data (in parallel)

Issue both MCP calls in a single tool-use batch — do not sequence them:

1. **`devspec__get_action_items`** with `agent_status: "completed"`, `limit: 50` — all completed autopilot items.
2. **`devspec__get_action_items`** with `agent_status: "failed"`, `limit: 50` — all failed autopilot items.

If either call fails, continue with the data that did succeed. If both fail, print `⚠ Unable to load history — MCP calls failed.` and exit cleanly.

---

## Step 2 — Merge and Sort

1. Concatenate the two arrays into a single list.

2. **Sort by `agent_claimed_at`** (ISO-8601 timestamp), most recent first.

3. **Use `new Date(agent_claimed_at)` for parsing. NEVER use regex or string manipulation on timestamps.** ISO-8601 values from Supabase can include timezone offsets, fractional seconds, and `Z` suffixes that regex handles poorly — and a bad parse silently turns every item into an `NaN` timestamp, corrupting the sort.

   If `new Date(...).getTime()` returns `NaN` for an entry, skip that entry in the sort (append to the end, or drop — caller's choice; this skill drops).

4. **Compute relative timestamps** for each entry. Use `Date.now() - claimed_ms` and format:
   - `< 60 s` → `<N>s ago`
   - `< 60 min` → `<N>m ago`
   - `< 24 h` → `<N>h ago`
   - `< 30 d` → `<N>d ago`
   - else → absolute ISO date `YYYY-MM-DD`

---

## Step 3 — Render History

Output the banner followed by one line per item. Show at most 20 entries (cap for readability; adjust the `limit` in Step 1 if you need more).

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ "{title}"
    {agent_branch} · {merge_status} · {relative_time}

  ✓ "{title}"
    {agent_branch} · push-only · {relative_time}

  ✗ "{title}"
    {agent_branch} · failed: {agent_error} · {relative_time}

  ━━ {total} total · {completed_count} completed · {failed_count} failed
```

Per-entry rules:
- **Completed items** (`agent_status === "completed"`): prefix `✓`, quote the `title`, show `agent_branch`, derive `merge_status` from `agent_merged` (`true` → `merged`, `false` → `push-only`), append relative time.
- **Failed items** (`agent_status === "failed"`): prefix `✗`, quote the `title`, show `agent_branch`, show `failed: <agent_error>` (truncate `agent_error` to 80 chars with `…` if longer), append relative time.
- **Missing fields**: show `(no branch)`, `(no error)`, `(unknown time)` for any field that is null/missing rather than omitting the row.
- **Quote the title** (wrap in `"…"`) so titles with special characters still render clearly.

The bottom line shows aggregate stats: total rows, completed count, failed count.

---

## Step 4 — Handle Empty History

If both calls succeed but return zero items total, output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  No autopilot history found.
```

---

## Key Details

- **Read-only.** No git operations, no file writes, no MCP calls that mutate state (no `claim_work_item`, `update_action_item`, `fail_work_item`).
- **Parallel MCP calls.** Both fetches in Step 1 are independent; issue them simultaneously to minimize latency.
- **Graceful degradation.** If one fetch fails, show the data that did succeed. If both fail, print one line and exit. Never crash the skill on an API error.
- **Timestamp parsing via `new Date(...)`.** Never regex, never string math on ISO-8601 timestamps — handles timezone offsets, fractional seconds, and `Z` suffixes correctly. NaN entries are dropped from the sort, not included with a garbage timestamp.
- **Cap at 20 rows** for readability. The `limit: 50` on each fetch gives enough headroom to find the most recent 20 across both arrays.
- **Cursor MCP prefix.** Tools are called as `devspec__get_action_items` etc. The `devspec__` prefix reflects the MCP server name registered in `mcp.json`.
- **Auto-discovered.** Cursor finds this skill via the `skills/` directory — no explicit path registration needed in `.cursor-plugin/plugin.json`.
