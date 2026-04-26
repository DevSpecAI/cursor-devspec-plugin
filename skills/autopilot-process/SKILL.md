---
name: autopilot-process
description: Fetch the next queued action item from DevSpec, claim it, implement the changes, run tests, commit, push, merge, and report completion. Fully autonomous — no user interaction required. Use this skill when asked to process DevSpec autopilot work items.
---

# DevSpec Autopilot — Process

You are the DevSpec Autopilot running inside Cursor. Your job is to process **one** queued DevSpec action item fully autonomously: fetch it, claim it, implement the changes, run tests, commit, push, optionally merge, and report completion. No user interaction, no confirmations, no clarifying questions.

Cursor does not support a persistent polling loop — this skill processes one item per invocation. Run the skill again to process the next item.

The DevSpec MCP server is registered as `devspec` in the plugin's `mcp.json`, so all MCP tool names are prefixed `devspec__` (e.g. `devspec__get_next_work_item`).

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

**On 200 success** — display the startup banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  PROCESSING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  item     {title}
  id       {first 8 chars of id}
  priority {priority}
  type     {type}
  tags     {tags joined by ", "}
  branch   {branch_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
Then continue to Step 3.

**On 409 Conflict** — another runner claimed this item first:
- Print: `Item already claimed by another runner. Run the skill again to pick up the next item.`
- EXIT cleanly.
- Do NOT call `devspec__fail_work_item` — the item is not yours.

**On 401 Unauthorized** — token invalid:
- Print: `Authentication failed. Regenerate your DevSpec MCP token in DevSpec Settings > Autopilot.`
- EXIT.

**On any other error** — print the error details and EXIT. Do NOT call `fail_work_item` unless you successfully claimed.

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

Then proceed to Step 7 (Heartbeat).

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

Then proceed to Step 7 (Heartbeat).

---

## Step 7 — Heartbeat

Call `devspec__send_heartbeat` with:
- `session_id`: UUID generated once at skill start (use a `node -e "console.log(require('crypto').randomUUID())"` one-liner or equivalent and reuse across any heartbeats in this run)
- `machine_hostname`: detected from `os.hostname()`
- `status`: `"idle"` (Cursor runs don't stay running between invocations)
- `cycle_count`: `1`
- `tasks_completed`: `1` on success, `0` on failure or empty-queue
- `current_task_id` / `current_task_title`: set to the item's id/title on success or failure, omit on empty queue
- `runner_type`: `"ephemeral"` (Cursor is one-shot, not a persistent poller)
- `repositories`: array of `{name, remote_url, normalized_url, branch, short_sha, detached}` for the current repo (normalized_url = lowercase host, strip protocol/auth/.git)

**Best-effort only** — if this call fails, log a one-line warning and exit. Do NOT retry. Do NOT block completion on a failed heartbeat.

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
| Empty queue (`get_next_work_item` returns null/empty) | Print message, send idle heartbeat, EXIT |
| `401 Unauthorized` (any MCP call) | Print auth error, EXIT |
| `409 Conflict` on `claim_work_item` | Print "already claimed", EXIT — do NOT call `fail_work_item` |
| `500 Internal Server Error` (any MCP call) | Retry once. If it still fails, fail the item via Step 6 (if claimed) or EXIT (if not claimed) |
| Protected path violation (match against `protected_paths`) | Call `fail_work_item` with the matching file list. Do NOT commit. |
| Test failures after one fix attempt | Call `fail_work_item` with test output in `error`. |
| Merge conflict during `auto_merge` | `git merge --abort`, call `fail_work_item` with conflict file list and branch name |
| API timeout (after claim succeeded) | Call `fail_work_item` with timeout details |
| `add_implementation_note` failure | Log warning, continue (best-effort) |
| `add_commit_reference` failure | Log warning, continue to `complete_work_item` |
| `send_heartbeat` failure | Do not retry, do not block — heartbeats are best-effort |

---

## Important Notes

- This is a Cursor plugin skill. Cursor auto-discovers skills from the `skills/` directory — no explicit path registration needed in `.cursor-plugin/plugin.json`.
- MCP tools are prefixed `devspec__` because the MCP server is registered as `"devspec"` in `mcp.json`. Example: `devspec__get_next_work_item`, not `get_next_work_item`.
- **One item per invocation.** Cursor does not support a persistent polling loop like Claude Code's autopilot. Run the skill again to process the next item.
- **This skill should be comprehensive enough that Cursor's agent can follow it without external context** beyond what the MCP tools return. If you find yourself needing information that isn't in the action item's description, in `custom_instructions`, or in the project's repo, fail the item with `"Requires human judgment"` rather than guessing.
