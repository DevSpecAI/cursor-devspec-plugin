---
name: autopilot.process
description: Process the next staged DevSpec action item (or a targeted list via --items=). Fully autonomous one-shot execution — no background polling. Cursor counterpart to a single autopilot cycle.
---

## Preflight — Verify DevSpec MCP availability

Before parsing the input or doing anything else, confirm the DevSpec MCP server is reachable from this chat:

1. Call `devspec__list_projects` with no arguments.
2. **If the call fails, the tool is not available, or any `devspec__*` tool is missing from your tool list**, stop immediately and tell the user:

   > **DevSpec MCP server is not reachable from this chat.** This usually means the chat thread was opened before the MCP server connected — for example, after editing `~/.cursor/mcp.json` or the DevSpec extension settings.
   >
   > **Fix:** Open a brand new Agent-mode chat and re-run this skill. Verify the `devspec` server shows green with all tools listed in **Cursor Settings → MCP & Integrations**.

   Do **not** proceed to file edits, branch creation, commits, or MCP mutations. Skipping this guard risks inconsistent DevSpec records.

The DevSpec MCP server is registered as `devspec` in `mcp.json`, so all MCP tool names are prefixed `devspec__`.

---

# DevSpec Autopilot — Process (Cursor one-shot)

Process staged DevSpec action items fully autonomously. **Cursor does not support background polling** — this skill processes **one item per invocation** by default. Use `--items=<uuid1>,<uuid2>` for a targeted batch, then exit.

## Input Parsing

Scan the user's invocation for flags (same semantics as Claude `autopilot.start`, minus polling):

- `--project-id=<uuid>` → `project_id_override`
- `--mine` (default) / `--assigned-to=<uuid>` / `--all` → assignee filter for `get_next_work_item`
- `--created-by=<uuid>` → creator filter (layers on assignee filter)
- `--items=<uuid1>,<uuid2>,...` → targeted FIFO queue; validate every UUID with `^[0-9a-f-]{36}$`; abort before any MCP call on invalid values
- When `--items` is present, set `targeted_mode = true` and process each UUID in order, then exit (no idle polling)

**Never pass `force: true` on `claim_work_item`.**

## Step 0 — Resolve project & load settings

1. Run `git remote get-url origin` and call `devspec__list_projects({ git_remote: "<remote>" })`.
   - Use `project_id_override` if set, else `remote_match.resolved_project_id`.
   - Multiple candidates → ask the user which project (or stop in unattended contexts).
   - No match → `✗ No DevSpec project tracks this repo (<git_remote>).` and stop.

2. Call `devspec__get_project_summary({ project_id })` and read the execution settings (the unified `execution` block — `auto_push`, `auto_merge`, `custom_instructions`, `agent_rules`, `test_commands`, `protected_paths`, … — plus the top-level `owner_agent_rules`; fall back to `local_plugin_settings` only if `execution` is absent) + `repos` + `database_targets`. Treat `custom_instructions` (team principles) and `agent_rules` + `owner_agent_rules` (execution mechanics) as mandatory when set.

3. Record `starting_branch` via `git branch --show-current`.

4. If autopilot is disabled in settings, print DISABLED banner and stop.

## Step 1 — Fetch work

**Targeted mode:** pop next UUID from queue; skip `get_next_work_item`; go to Step 2.

**Default mode:** call `devspec__get_next_work_item({ project_id, assigned_to?, created_by? })`.
- Empty → print `No staged items — nothing to process.`, send idle `devspec__send_heartbeat`, EXIT.
- **Never use `get_action_items` to fetch staged work in bulk** — context overflow risk.

## Step 2 — Process by agent_activity

Pick planning / under_human_review / staged per the Claude autopilot skill priority. For **staged** items, follow the full execution path below.

### Staged — full execution



## Step 3 — Heartbeat & loop-back

1. Call `devspec__send_heartbeat` (best-effort) with `status: "idle"` or `"working"` as appropriate.

2. **Targeted mode:** if more UUIDs remain, return to Step 1. If queue empty, EXIT.

3. **Default mode:** EXIT after one item (re-run the skill for the next item).

## Failure Handling



On failure after a successful claim, call `devspec__update_action_item` with `agent_activity: 'failed'` and `agent_error`. **Never call `update_action_item` failed on a 409 claim rejection** — the item belongs to another runner.

## Argument reference (from autopilot.start)


# Start DevSpec Autopilot

You are starting the DevSpec Autopilot. Follow the autopilot skill instructions to enter the polling loop.

## Arguments

Parse `$ARGUMENTS` into independent session variables. Flags can be combined freely (e.g. `--all --drain`, `--assigned-to=<uuid> --created-by=<uuid>`, `--items=<uuid1>,<uuid2>`, `--project-id=<uuid>`).

### `project_id_override` (account-wide token disambiguation)

- `--project-id=<uuid>` → `project_id_override = "<uuid>"`
- nothing → `project_id_override = null`

DevSpec MCP tokens are **account-wide**, so the runner resolves which project to operate on at startup from the workspace git remote (see the skill's Startup step 1: `devspec__list_projects({ git_remote })` → `remote_match.resolved_project_id`). Pass `--project-id=<uuid>` **only when that resolution is ambiguous** — i.e. the repo is tracked by more than one DevSpec project, so `resolved_project_id` comes back null with multiple `candidate_project_ids`. The override skips git-remote resolution and pins the run to the given project. Validate the uuid against `^[0-9a-f-]{36}$`; on failure output `✗ Invalid UUID in --project-id: <value>` and stop before entering the loop.

### `assigned_to_filter` (default — assignee-based ownership)

- `--mine` → `assigned_to_filter = "me"` (explicit; same as default)
- `--assigned-to=<user_id>` → `assigned_to_filter = "<user_id>"` (run on a specific teammate's queue)
- `--all` → clear `assigned_to_filter` (legacy shared-queue behaviour — see precedence below)
- nothing → `assigned_to_filter = "me"` (default)

This is passed as the `assigned_to` argument on every `get_next_work_item` call. The server-side semantic:
- `assigned_to: "me"` matches items where the caller is in the assignee set **OR** the item has zero assignees (the grab-bag pool).
- `assigned_to: "<uuid>"` matches items where that user is in the assignee set **OR** the item has zero assignees.
- Omitted (i.e. `--all`) → no assignee filter; every item the caller can see is eligible.

### `created_by_filter` (independent, opt-in)

- `--created-by=<user_id>` → `created_by_filter = "<user_id>"` (filter to items authored by that user)
- nothing → `created_by_filter = null` (no creator filter)

`created_by` is layered on top of `assigned_to` — both must match when both are set. It is an explicit opt-in filter, ANDed with `assigned_to`.

### `drain_on_empty`

- `--drain` → `drain_on_empty = true`
- nothing → `drain_on_empty = false`

When true, the autopilot exits (with the normal stop summary) on the **first idle cycle** instead of entering adaptive idle sleep. Use this to "process everything in the queue and then quit".

### `item_id_queue` (targeted run)

- `--items=<uuid1>,<uuid2>,...` → `item_id_queue = ["<uuid1>", "<uuid2>", ...]` (items are processed in the given order, then the loop exits)
- nothing → `item_id_queue = []`

Split the value on `,`, trim whitespace around each entry, and validate each UUID against `^[0-9a-f-]{36}$` before storing. If any value fails validation, output `✗ Invalid UUID in --items: <value>` and stop **before** entering the polling loop — do not claim, fetch, or heartbeat.

When `item_id_queue` is non-empty, the session is in **targeted mode**:
- The polling loop pops UUIDs from this queue in order and processes them directly, skipping the regular `devspec__get_next_work_item()` call.
- `drain_on_empty = true` is implied automatically — the loop exits cleanly once the last targeted item finishes (success or failure), with no idle sleep.
- Mixing `--items` with `--drain` has no unexpected interaction: the drain flag is already implied, so passing it explicitly is a no-op.

### Flag precedence

Explicit UUID flags (`--assigned-to=<uuid>`, `--created-by=<uuid>`) > `--all` > `--mine` > default. If a caller passes both `--all` and `--assigned-to=<uuid>`, the explicit UUID wins.

### Common recipe: everything you created, regardless of assignee

```
`autopilot.process`.start --all --created-by=<your_user_id>
```

Processes only the items **you authored**, no matter who they are assigned to. Both flags are required: `--created-by` is ANDed on top of the assignee filter, and the default assignee filter is `--mine` (assigned to you OR unassigned). So `--created-by=<uuid>` *alone* skips items you created but assigned to a teammate. `--all` clears the assignee filter, leaving `--created-by` as the only narrowing condition. There is no "staged" flag — the autopilot only ever fetches and claims staged work, so `--created-by` already means "staged items created by that user".

### Force-claim is NOT used by default

`claim_work_item` accepts a `force: true` flag that bypasses the assignee-aware claim guard. The autopilot loop **MUST NOT** pass `force: true`. If `claim_work_item` rejects with an `assigned to other users` error, treat it like any other claim rejection: log it, move on to the next item, and let the assignee pick the work up themselves. The loop never overrides someone else's claim.

## Steps

1. Parse `$ARGUMENTS` per above and store the flags (`assigned_to_filter`, `created_by_filter`, `project_id_override`, `drain_on_empty`, `item_id_queue`) in session state. If `--items=` is present, validate every UUID per the rule above and stop with a clear error on the first invalid value — do NOT enter the polling loop. If `--project-id=` is present, validate its UUID too and stop on failure. If `item_id_queue` ends up non-empty, also set `drain_on_empty = true` (it is implied). Flags are otherwise independent — any combination is valid (e.g. `--mine --drain`, `--assigned-to=<uuid> --created-by=<uuid>`, `--items=<uuid>`, `--project-id=<uuid>`).
2. **Resolve the project (account-wide token).** Follow the skill's Startup steps 0–1: run the one startup bash call to collect the workspace git remote, then resolve `project_id`:
   - If `project_id_override` is set, use it directly as `project_id` and skip git-remote resolution.
   - Otherwise call `devspec__list_projects({ git_remote: "<primary repo's origin remote>" })` and read `remote_match`. Use `resolved_project_id` when non-null. If it is null with `candidate_project_ids`, the repo is tracked by multiple projects — output a `DISABLED`-style banner naming the candidates and advising ``autopilot.process`.start --project-id=<uuid>`, then stop (never guess). If there is no match at all, stop with "No DevSpec project tracks this repo (`<git_remote>`)."
3. Call `devspec__get_project_summary({ project_id })` to fetch project settings including autopilot configuration
4. If autopilot is not enabled in settings, output a warning and stop:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ◆  DEVSPEC AUTOPILOT  ▸  DISABLED
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Autopilot is not enabled in project settings.
     Enable it in DevSpec project settings to use this feature.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
5. Output the startup banner as defined in the skill's Output Formatting section. Include a `filter:` line that reflects the active assignee-filter state:
   - Default / `--mine`: `filter: assigned to you (+ unassigned)`
   - `--assigned-to=<uuid>`: `filter: assigned to <short_id> (+ unassigned)`
   - `--all`: `filter: shared queue (no filter)`
   When `created_by_filter` is set, also include a separate `created_by: <short_id>` line. When `drain_on_empty` is set, include a `drain: on` line. When `item_id_queue` is non-empty, include a `mode: targeted (N items specified)` line so the operator can see at a glance that the session is processing a fixed list rather than the live queue.
6. Enter the polling loop as defined in the autopilot skill (skills`autopilot.process`/SKILL.md), passing the resolved `project_id` and all the flags through — the skill threads `project_id` on every project-scoped call (`get_next_work_item`, `get_action_items`, `send_heartbeat`, `search_memories`, …), uses `assigned_to_filter` and `created_by_filter` on every `get_next_work_item` call, pops from `item_id_queue` at the Fetch Work step when it is non-empty, and checks `drain_on_empty` at the Wait step.
7. Follow ALL formatting rules from the skill — use Unicode symbols, compact status lines, and timestamps

When `drain_on_empty` is false (default) and `item_id_queue` is empty, the autopilot continues running until you receive ``autopilot.process`.stop` or the session ends. When `drain_on_empty` is true, it stops on the first idle cycle. When `item_id_queue` is non-empty, the loop processes the listed items in order and then exits cleanly via the same drain-then-exit path.



## Cursor-specific notes

- **Read before edit:** Always read a file before editing it — Cursor's edit tools require this.
- **Windows `node_modules/.bin` fallback:** If `npm run <cmd>` fails with a PATH error in a worktree, retry once using `node ./node_modules/typescript/bin/tsc --noEmit` (for tsc) or `node ./node_modules/.bin/<cmd>` for other binaries.
- **Stale chat MCP state:** If MCP was reconfigured, open a **new** Agent-mode chat — existing chats cache old tool availability.
- **Provider:** Always pass `provider: "cursor"` on completion/recording calls.

