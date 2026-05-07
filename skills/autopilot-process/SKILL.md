---
name: autopilot-process
description: Fetch the next queued action item from DevSpec, claim it, implement the changes, run tests, commit, push, merge, and report completion. Fully autonomous — no user interaction required. Use this skill when asked to process DevSpec autopilot work items.
---

# DevSpec Autopilot — Process

You are the DevSpec Autopilot running inside Cursor. Your job is to process queued DevSpec action items fully autonomously: fetch each one, claim it, implement the changes, run tests, commit, push, optionally merge, and report completion. No user interaction, no confirmations, no clarifying questions.

Cursor does not support a persistent polling loop. By default this skill processes **one** queued item per invocation — run the skill again to pick up the next item. In **targeted mode** (when invoked with `--items=<uuid1>,<uuid2>,...`), the skill processes the listed items in order and then exits cleanly without polling.

The DevSpec MCP server is registered as `devspec` in the plugin's `mcp.json`, so all MCP tool names are prefixed `devspec__` (e.g. `devspec__get_next_work_item`).

---

## Input Parsing — Targeted Mode

Before running Preflight, scan the user's invocation text for a `--items=` flag.

Patterns to recognize (case-sensitive, equals-form only — do **not** accept space-separated values to avoid ambiguity with stray pasted text):

```
--items=<uuid1>,<uuid2>,<uuid3>
--items=<uuid>
```

1. If the flag is **absent**, set `item_id_queue = []` and `targeted_mode = false`. Continue to Preflight as normal.
2. If the flag is **present**:
   - Split the value on `,`, trim whitespace around each entry, and discard empty entries.
   - Validate **every** entry against the regex `^[0-9a-f-]{36}$`.
   - If any entry fails validation, print `✗ Invalid UUID in --items: <value>` and **EXIT immediately** — do NOT call any MCP tool, do NOT claim, do NOT heartbeat. The whole invocation aborts before any side effects.
   - Store the validated list as `item_id_queue` (in input order) and set `targeted_mode = true`.
3. If `targeted_mode` is true, also force `auto_drain = true` — after the last item finishes (success or failure), the skill exits cleanly with no idle polling and no further fetches.

Targeted mode changes how Steps 1, 2, and 7 (loop-back) behave; it does **not** change Steps 3–6 (work execution and reporting). The same per-item flow runs for each UUID popped from the queue.

---

## Preflight — Verify DevSpec MCP availability

Before loading settings or doing anything else, confirm the DevSpec MCP server is actually reachable from this chat:

1. Call `devspec__list_projects` with no arguments.
2. **If it succeeds**, continue to Step 0.
3. **If the call fails, the tool is not available, or any `devspec__*` tool is missing from your tool list**, stop immediately and tell the user:

   > **DevSpec MCP server is not reachable from this chat.** This usually means the chat thread was opened before the MCP server connected — for example, after editing `~/.cursor/mcp.json` or the DevSpec extension settings.
   >
   > **Fix:** Open a brand new Agent-mode chat and re-run this skill. Verify the `devspec` server shows green with all tools listed in **Cursor Settings → MCP & Integrations**.

   Do **not** proceed to claim a work item, edit files, or commit. Skipping this guard risks shipping code to staging without claiming the action item or recording the commit reference, which leaves the DevSpec record inconsistent with the codebase.

---

## Step 0 — Load Settings

1. Capture the starting branch so it can be used as a merge target fallback:
   ```
   git branch --show-current
   ```
   Store as `starting_branch`.

2. Call `devspec__get_project_summary` with no parameters. Read `local_plugin_settings` from the response and extract:
   - `auto_push` (boolean, default `false`) — push feature branch after commit
   - `auto_merge` (boolean, default `false`) — merge into the target branch after push. If `auto_merge` is `true`, force `auto_push = true` regardless of its stored value.
   - `target_branch` (string, default `""` — fall back to `starting_branch` if empty)
   - `branch_prefix` (string, default `"work/action-item-"`)
   - `custom_instructions` (string, default `""`) — project-owner-defined rules that are mandatory for every item
   - `protected_paths` (array of glob patterns, default `[]`) — files that MUST NEVER be modified. Touching one fails the item.

3. If `custom_instructions` is non-empty, treat its content as mandatory requirements throughout Steps 3–5.

---

## Step 1 — Fetch Next Item

### Targeted mode (`targeted_mode == true`)

1. **If `item_id_queue` is empty** (the last targeted item just finished): proceed to the loop-back check at the end of Step 5/6 — do NOT fetch another item.
2. **If `item_id_queue` is non-empty**:
   - Pop the **first** UUID from `item_id_queue` (FIFO).
   - Store `action_item_id = <popped UUID>`.
   - Re-validate `action_item_id` against `^[0-9a-f-]{36}$` (defense in depth — Input Parsing already validated, but never trust an in-memory value passed to a shell or MCP call).
   - Compute `branch_name = <branch_prefix> + first 8 chars of action_item_id`. Validate against `^[a-zA-Z0-9/_.-]+$`.
   - **Skip** `devspec__get_next_work_item` entirely — the popped UUID *is* the next item. Proceed directly to Step 2 (claim).

### Default mode (`targeted_mode == false`)

1. Call `devspec__get_next_work_item` with no parameters.

2. **If the response is null, empty, or has no `item` field**:
   - Print: `No items queued — nothing to process.`
   - Send an idle heartbeat (Step 7 with `status: "idle"`, `cycle_count: 1`, `tasks_completed: 0`).
   - EXIT cleanly.

3. **On success**:
   - Store `action_item_id = <returned id>`.
   - Compute `branch_name = <branch_prefix> + first 8 chars of action_item_id`.
   - Validate: `action_item_id` must match `^[0-9a-f-]{36}$`; `branch_name` must match `^[a-zA-Z0-9/_.-]+$`. If either fails, EXIT with a clear error — do NOT proceed to claim.

---

## Step 2 — Claim the Item (IMMEDIATELY)

Call `devspec__claim_work_item` with:
- `action_item_id` — the UUID from Step 1
- `agent_branch` — the `branch_name` from Step 1

**This call MUST happen immediately after Step 1 fetch succeeds** — before reading the description in detail, planning, or doing anything else. Claiming is atomic: another runner could grab the item between fetch and claim if you delay.

**On 200 success** — display the startup banner. In targeted mode, include a `mode` line and a `remaining` line so the operator can see at a glance that the runner is processing a fixed list:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  PROCESSING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  item      {title}
  id        {first 8 chars of id}
  priority  {priority}
  type      {type}
  tags      {tags joined by ", "}
  branch    {branch_name}
  mode      targeted ({N} items specified)        ← only when targeted_mode
  remaining {M} more after this                   ← only when targeted_mode
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
`{N}` is the original size of `item_id_queue` at invocation; `{M}` is the count still in `item_id_queue` after the current pop. Omit both lines in default mode.

Then continue to Step 3.

**On 409 Conflict** — another runner claimed this item first:
- **Default mode**: print `Item already claimed by another runner. Run the skill again to pick up the next item.` and EXIT cleanly.
- **Targeted mode**: print `Item {first 8 chars} already claimed or no longer queued — skipping to next targeted item.` and **continue** — return to Step 1 to pop the next UUID. Do NOT exit, do NOT call `devspec__fail_work_item` (the item is not yours), do NOT pass `force: true` (the autopilot never overrides another claim).
- In both modes, never call `fail_work_item` on a 409 — the item belongs to another runner.

**On 401 Unauthorized** — token invalid:
- Print: `Authentication failed. Regenerate your DevSpec MCP token in DevSpec Settings > Autopilot.`
- EXIT (in both modes — auth failure cannot be skipped past).

**On any other error** — print the error details and EXIT. Do NOT call `fail_work_item` unless you successfully claimed. In targeted mode, an unexpected non-409 error still aborts the whole run rather than skipping; this is intentional because the failure mode is unknown and continuing risks a cascading bad state.

---

## Step 3 — Understand the Work

1. Read the claimed item's full `description`, `affected_files`, `tags`, `type`, and `priority`.

2. If `custom_instructions` from Step 0 is non-empty, treat its content as mandatory requirements. These are project-owner-defined rules (e.g. "always add tests", "update CHANGELOG.md", specific tool preferences) that apply on top of the action item's description.

3. Read every file listed in `affected_files` before doing anything else. If `affected_files` is empty or missing, read files mentioned in the description and adjacent files that appear relevant to the change.

4. Plan the implementation approach before writing any code. A clear internal plan prevents false starts and incomplete changes.

---

## Step 4 — Implement

1. **Create the feature branch** (name was validated in Step 1):
   ```
   git checkout -b {branch_name}
   ```

2. **Always read a file before editing it.** Cursor's edit tools reject writes to files not read in the current session; read-before-edit also avoids clobbering existing content.

3. **Write changes** following the project's existing conventions and any `custom_instructions` loaded in Step 0.

4. **Record progress** (best-effort, continue on failure): call `devspec__add_implementation_note` with `action_item_id` and a short markdown summary of what changed so far. Useful for long implementations where the final summary would otherwise dump at the very end.

5. **Run available tests** (check which commands exist before running them — `package.json` scripts, `Makefile`, `.tool-versions`, language-specific runners):
   - `npm test`
   - `npm run lint`
   - `npm run typecheck`
   - Project-specific test commands from `custom_instructions`

   If a test fails, attempt **one** fix for it. If it still fails after that attempt, treat as a failure condition and go to Step 6.

   **Windows fallback**: if `npm run <cmd>` or `npx <cmd>` fails with a "not recognized" / PATH error (common when `node_modules/.bin` shims don't resolve correctly), retry once using the direct node path:
   - For `tsc`: `node ./node_modules/typescript/bin/tsc --noEmit`
   - For other binaries: `node ./node_modules/.bin/<cmd>`

   If the direct node path also fails, treat as a real test failure.

6. **Check protected paths** BEFORE committing:
   ```
   git diff --name-only
   ```
   For each changed file, check against every glob in `protected_paths` from Step 0. If ANY file matches ANY protected pattern, **go to Step 6 (Report Failure)** — list the matching files in the error. Do NOT commit.

7. **Stage specific files only** — NEVER use `git add -A` or `git add .`:
   ```
   git add <file1> <file2> ...
   ```
   Use the output of `git diff --name-only` to know which files to stage.

8. **Commit** with the `[devspec:<id>]` tracking tag in the message body:
   ```
   git commit -m "[autopilot] {short description}

[devspec:{action_item_id}]"
   ```
   The `[devspec:<id>]` tag is what the deployment webhook uses to link successful deployments back to the action item. Never omit it. Never hand-craft a different format — match this template exactly.

9. **Push** if `auto_push` OR `auto_merge`:
   ```
   git push -u origin {branch_name}
   ```

10. **Merge** if `auto_merge`:
    - Compute `merge_target` = `target_branch` if non-empty, else `starting_branch`.
    - Validate `merge_target` matches `^[a-zA-Z0-9/_.-]+$`. If it fails, go to Step 6.
    ```
    git checkout {merge_target}
    git merge {branch_name} --no-ff --no-edit
    git push origin {merge_target}
    ```
    - Set `agent_merged = true`.
    - **On merge conflict**: go to Step 6 with `git merge --abort` attempted first to restore the main repo.

    If `auto_merge` is not enabled, set `agent_merged = false`.

---

## Step 5 — Report Success

All three MCP calls are MANDATORY and must be called in this order. Never skip any.

1. **`devspec__add_implementation_note`** — a substantive markdown summary of what was changed, which files were modified, and any notable decisions. This is the audit trail the project owner reviews.

2. **`devspec__add_commit_reference`** — link the commit:
   ```
   {
     "action_item_id": "<uuid>",
     "commit_sha": "<full 40-char SHA>",
     "commit_message": "<full commit subject line>"
   }
   ```

3. **`devspec__complete_work_item`** with ALL of the following fields (every one is required — omit nothing):
   - `action_item_id`: the full UUID from Step 1
   - `commit_sha`: the full 40-character SHA from `git rev-parse HEAD`
   - `agent_merged`: `true` or `false` from Step 4
   - `affected_files`: array of file paths from `git diff --name-only` (run before cleanup)
   - `completion_note`: 2–3 paragraph markdown — what changed, why, key decisions made
   - `completion_summary`: 2–4 sentences for non-technical stakeholders. Written as a changelog entry.
   - `testing_notes`: numbered markdown steps (minimum 3) that a non-developer tester can follow. Reference specific URLs, UI elements, expected outcomes.
   - `usage_notes`: where users can find this feature in the UI (e.g. "Navigate to Settings → Integrations"). Empty string `""` for non-user-facing changes (refactors, infra, invisible bug fixes).
   - `verification_report`:
     - `verification_type`: `"automated"` (all checks passed), `"human_required"` (tests can't cover it), or `"partial"` (some checks passed but human review still needed)
     - `automated_checks_passed`: array of check names that passed (e.g. `["typecheck", "unit tests", "lint"]`). Only list checks that actually ran and passed.
     - `confidence`: 0.0–1.0. 0.9+ = straightforward change with full test coverage. 0.7–0.9 = tests pass but change is complex. <0.7 = significant uncertainty.
     - `human_review_needed`: array of specific things a human should verify and why. Be specific.
   - `provider`: always `"cursor"`
   - `completion_mode`: always `"autopilot"`

After the three calls succeed, print a completion banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓  DEVSPEC AUTOPILOT  ▸  COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  item     {title}
  commit   {first 8 chars of sha}
  merged   {yes/no}
  files    {count} changed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Loop-back (targeted mode only)**: if `targeted_mode` is `true` and `item_id_queue` is non-empty, return to **Step 1** to pop and process the next UUID. Reuse the same `session_id`, `starting_branch`, and settings loaded in Step 0 — do NOT re-run Preflight or Step 0. The per-item state (`action_item_id`, `branch_name`, `agent_merged`, etc.) resets for each new pop.

If `targeted_mode` is `true` and `item_id_queue` is empty, proceed to Step 7 (Heartbeat) and then EXIT — no idle polling.

If `targeted_mode` is `false`, proceed to Step 7 (Heartbeat) and EXIT after the single item — Cursor invocations are one-shot in default mode.

---

## Step 6 — Report Failure

Failure handling is a "finally" path — it runs regardless of which Step 4 sub-step failed. Only call `fail_work_item` if the item was successfully claimed in Step 2 (claim succeeded). If Step 2 returned 409 Conflict, the item is not yours — do NOT call `fail_work_item`.

1. **Abort in-flight git operations** (best-effort — harmless if nothing is in progress):
   ```
   git merge --abort
   git rebase --abort
   ```

2. **Call `devspec__fail_work_item`** with:
   - `action_item_id`: the UUID
   - `error`: a description of what went wrong and which step failed
   - `partial_work`: the branch name and any partial commits made (helps the reviewer)

3. Print a failure banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✗  DEVSPEC AUTOPILOT  ▸  FAILED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  item     {title}
  step     {which step failed}
  error    {brief reason}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Loop-back (targeted mode only)**: a per-item failure is treated the same as a per-item success for queue progression — if `targeted_mode` is `true` and `item_id_queue` is still non-empty, return to **Step 1** to pop the next UUID. The remaining items still get a chance to run; a single failure does not abort the whole batch. The exception is the unrecoverable cases handled in Step 2 (401, unknown non-409 errors), which exit immediately.

If `targeted_mode` is `false`, or the queue is empty, proceed to Step 7 (Heartbeat) and EXIT.

---

## Step 7 — Heartbeat

Call `devspec__send_heartbeat` once at the **end** of the invocation (after the last item finishes in targeted mode, or after the single item in default mode):

- `session_id`: UUID generated once at skill start (use a `node -e "console.log(require('crypto').randomUUID())"` one-liner or equivalent and reuse across any heartbeats in this run)
- `machine_hostname`: detected from `os.hostname()`
- `status`: `"idle"` (Cursor runs don't stay running between invocations)
- `cycle_count`: total items processed during this invocation. Default mode: `1`. Targeted mode: the original size of `item_id_queue` at invocation (each pop counts as one cycle, including the ones that hit 409 or failed).
- `tasks_completed`: count of items that reached `complete_work_item` successfully. Default mode: `1` on success, `0` on failure or empty-queue. Targeted mode: the number of successful completions across all popped items.
- `current_task_id` / `current_task_title`: set to the **last** item's id/title processed during this invocation (success or failure). Omit on empty-queue or when no item was claimed.
- `runner_type`: `"ephemeral"` (Cursor is one-shot, not a persistent poller)
- `repositories`: array of `{name, remote_url, normalized_url, branch, short_sha, detached}` for the current repo (normalized_url = lowercase host, strip protocol/auth/.git)

**Best-effort only** — if this call fails, log a one-line warning and exit. Do NOT retry. Do NOT block completion on a failed heartbeat. In targeted mode, only the **final** heartbeat is sent — no per-item heartbeats during the loop, matching the `--drain` behaviour of the Claude Code and Gemini autopilots.

---

## Safety Rules

These apply throughout every step. Any violation is a bug in this skill's execution.

- **Never ask the user for input, confirmation, or clarification.** This skill is autonomous.
- **Never force-push** to any branch.
- **Never push directly to protected branches** unless explicitly configured as the target.
- **Never modify files matching `protected_paths` patterns.** Any match is an immediate failure.
- **Never use `git add -A` or `git add .`** — always stage specific files.
- **Always read a file before editing it.** Cursor's edit tools require this; skipping wastes tool calls.
- **If the task is too vague, ambiguous, or requires human judgment**, call `devspec__fail_work_item` with error `"Requires human judgment"` rather than guessing.
- **Never self-craft the `[devspec:<id>]` commit tag.** Use the exact format shown in Step 4 — the deployment webhook parses this tag to link deployments back to the item.
- **One retry maximum** on any failing command (test commands, Windows npm shims, transient 5xx server errors). After the retry, treat as a real failure.
- **Never stop the loop due to heartbeat failures** — heartbeats are best-effort telemetry, not correctness gates.

---

## Error Handling Quick Reference

| Scenario | Action |
|----------|--------|
| Invalid UUID in `--items=` value | Print `✗ Invalid UUID in --items: <value>`, EXIT before any MCP call. No claim, no heartbeat. |
| Empty queue (`get_next_work_item` returns null/empty, default mode only) | Print message, send idle heartbeat, EXIT |
| Targeted-mode queue exhausted (last UUID processed) | Send final heartbeat with `tasks_completed = <success count>`, EXIT cleanly — no idle polling |
| `401 Unauthorized` (any MCP call) | Print auth error, EXIT (in both modes) |
| `409 Conflict` on `claim_work_item` (default mode) | Print "already claimed", EXIT — do NOT call `fail_work_item` |
| `409 Conflict` on `claim_work_item` (targeted mode) | Print "skipping to next targeted item", continue to next UUID — do NOT call `fail_work_item`, do NOT pass `force: true` |
| `500 Internal Server Error` (any MCP call) | Retry once. If it still fails, fail the item via Step 6 (if claimed) or EXIT (if not claimed) |
| Protected path violation (match against `protected_paths`) | Call `fail_work_item` with the matching file list. Do NOT commit. In targeted mode, continue to next UUID after failure. |
| Test failures after one fix attempt | Call `fail_work_item` with test output in `error`. In targeted mode, continue to next UUID. |
| Merge conflict during `auto_merge` | `git merge --abort`, call `fail_work_item` with conflict file list and branch name. In targeted mode, continue to next UUID. |
| API timeout (after claim succeeded) | Call `fail_work_item` with timeout details. In targeted mode, continue to next UUID. |
| `add_implementation_note` failure | Log warning, continue (best-effort) |
| `add_commit_reference` failure | Log warning, continue to `complete_work_item` |
| `send_heartbeat` failure | Do not retry, do not block — heartbeats are best-effort |

---

## Important Notes

- This is a Cursor plugin skill. Cursor auto-discovers skills from the `skills/` directory — no explicit path registration needed in `.cursor-plugin/plugin.json`.
- MCP tools are prefixed `devspec__` because the MCP server is registered as `"devspec"` in `mcp.json`. Example: `devspec__get_next_work_item`, not `get_next_work_item`.
- **Default mode: one item per invocation.** Cursor does not support a persistent polling loop like Claude Code's autopilot. Run the skill again to process the next item.
- **Targeted mode: N items per invocation.** When invoked with `--items=<uuid1>,<uuid2>,...`, the skill processes the listed items in order (popping from the queue one at a time, running the full claim → implement → report flow per item) and then exits cleanly when the queue is exhausted. No idle polling, no further `get_next_work_item` calls. A 409 on any item skips to the next; auth or unknown errors abort the whole batch.
- **Invocation example (Cursor command palette):** `Run autopilot-process skill — input: --items=6f42cd8f-c1e5-4798-ac46-04e200ff452b,de8333f6-bddc-48f6-a540-5229509cd8ab`. The extension copies the skill prompt with this input attached to the clipboard; pasting it into Agent-mode chat triggers the targeted run.
- **This skill should be comprehensive enough that Cursor's agent can follow it without external context** beyond what the MCP tools return. If you find yourself needing information that isn't in the action item's description, in `custom_instructions`, or in the project's repo, fail the item with `"Requires human judgment"` rather than guessing.
