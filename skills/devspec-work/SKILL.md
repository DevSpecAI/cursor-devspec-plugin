---
name: devspec-work
description: Pick up a specific DevSpec action item by name or ID, optionally brainstorm the approach, then implement, test, commit, push, merge, and report completion. Supports interactive and --unattended modes. Use when the user wants to work on a specific DevSpec item, or says "work on [item]".
---

# DevSpec — Work

Interactive skill for picking up and implementing a **specific** DevSpec action item (unlike `autopilot-process`, which processes the next queued item). Supports an optional brainstorm phase, both interactive and unattended modes, and uses `generate_commit_message` to produce deployment-tracking commits.

The DevSpec MCP server is registered as `devspec` in `mcp.json`, so all MCP tool names are prefixed `devspec__`.

---

## Preflight — Verify DevSpec MCP availability

Before parsing the input or doing anything else, confirm the DevSpec MCP server is actually reachable from this chat:

1. Call `devspec__list_projects` with no arguments.
2. **If it succeeds**, continue to the next phase.
3. **If the call fails, the tool is not available, or any `devspec__*` tool is missing from your tool list**, stop immediately and tell the user:

   > **DevSpec MCP server is not reachable from this chat.** This usually means the chat thread was opened before the MCP server connected — for example, after editing `~/.cursor/mcp.json` or the DevSpec extension settings, or after fixing a misconfigured URL.
   >
   > **Fix:** Open a brand new Agent-mode chat and re-run this skill. Verify the `devspec` server shows green with all tools listed in **Cursor Settings → MCP & Integrations**.

   Do **not** proceed to file edits, branch creation, or commits. Skipping this guard risks shipping code to staging without claiming the action item or recording the commit reference, which leaves the DevSpec record inconsistent with the codebase.

---

## Input Parsing

The user's invocation carries an **item identifier** — a full UUID, partial ID (first 8 characters), exact title, or title keywords.

Also detect **unattended mode** triggers in the input: `--unattended`, `unattended`, or `no interruptions`. Store as boolean `is_unattended`. In unattended mode, zero prompts are issued — missing information is inferred or fails cleanly.

---

## Phase 1 — Resolve Item

1. Call `devspec__get_action_items` with `agent_status: "queued"`, `agent_ready: true`, `limit: 50` — returns available queued items.

2. Match the user's identifier against each item's `id` and `title`:
   - Exact UUID match wins.
   - Partial ID prefix match (8 chars) wins if unambiguous.
   - Title substring match (case-insensitive) otherwise.

3. **Exactly one match** → use it.

4. **Multiple matches** (ambiguity):
   - **Interactive**: display a numbered list (`1. {title} [{id8}]`) and ask the user to pick a number.
   - **Unattended**: auto-select the highest-priority item (critical > high > medium > low); ties broken by most-recently-created.

5. **Zero matches**:
   - Print `✗ No matching queued items. Check the queue in DevSpec or adjust your identifier.`
   - Exit.

6. Once resolved, fetch context **in parallel** (single tool-use batch):
   - `devspec__get_action_item_history` with `action_item_id` — prior notes, commits, status changes.
   - `devspec__search_memories` with `query: "<item title>"` — related decisions, conventions, risks. Graceful degradation: continue if this fails.

---

## Phase 2 — Brainstorm (Optional)

**Unattended mode**: skip this phase entirely. Go to Phase 3.

**Interactive mode**: ask exactly once — `Brainstorm before starting? (y/n, default n)`. Proceed to Phase 3 on `n` / empty / anything not `y`.

When brainstorming:

1. **Multi-round Q&A loop.** Each round asks up to 5 questions sampled across these six taxonomy categories (prioritize gaps the user hasn't already addressed):
   - **Scope and Intent** — core problem, explicit out-of-scope
   - **Approach and Alternatives** — strategies considered, why this one
   - **Data and State** — migrations, data model changes, reversibility
   - **Edge Cases and Failure Modes** — invalid input, concurrency, timeouts
   - **Dependencies and Integration** — other systems, downstream impact
   - **Acceptance and Verification** — how will we know it's done

2. For each question: present an **AI-suggested answer** with a short rationale, then ask `Accept / adjust / skip`. Accept on `yes`/`accept`/empty, skip on `skip`.

3. **Auto-terminate** when:
   - All six categories have been addressed, OR
   - User says `done` / `good` / `stop`, OR
   - No meaningful gaps remain (self-assess at end of each round).

4. **Compile a structured brainstorm summary** and save via `devspec__add_implementation_note(action_item_id, content)`. Output: `✓ Brainstorm saved`.

---

## Phase 3 — Claim and Implement

1. **Load settings**: call `devspec__get_project_summary`, read `local_plugin_settings`:
   - `auto_push` (bool, default `false`)
   - `auto_merge` (bool, default `false` — if `true`, force `auto_push: true`)
   - `target_branch` (string; empty → fall back to `starting_branch`)
   - `branch_prefix` (string, default `work/action-item-`)
   - `custom_instructions` (string) — mandatory throughout implementation
   - `protected_paths` (array of glob patterns) — MUST NEVER be modified

2. **Compute `branch_name`** = `{branch_prefix}{first 8 chars of action_item_id}`. Validate against `^[a-zA-Z0-9/_.-]+$`; fail the invocation if invalid.

3. **Claim**: `devspec__claim_work_item({action_item_id, agent_branch: branch_name})`.
   - On `200` success: proceed.
   - On `409 Conflict`: print `✗ Item already claimed by another runner.` — EXIT cleanly. Do NOT call `fail_work_item` (not yours to fail).
   - On `401 Unauthorized`: print auth error — EXIT.
   - On other error: print details — EXIT.

4. **Create the feature branch**:
   ```
   git checkout -b {branch_name}
   ```

5. **Implement** the changes, following `custom_instructions` as mandatory requirements and the action item's description.

6. **Always read a file before editing it.** Cursor's edit tools require this; read-before-edit also avoids clobbering existing content.

7. **Run tests** — probe for `package.json` scripts, `Makefile`, language-specific runners, and any commands in `custom_instructions`:
   - `npm test`
   - `npm run lint`
   - `npm run typecheck`

   **One fix attempt per failing test.** If it still fails, fail the item (Failure Handling below).

   **Windows `node_modules/.bin` fallback**: if `npm run <cmd>` fails with a PATH error, retry once using the direct node path (`node ./node_modules/typescript/bin/tsc --noEmit` for tsc, `node ./node_modules/.bin/<cmd>` for other binaries). Max one retry per command.

8. **Check protected paths** before committing:
   ```
   git diff --name-only
   ```
   For each changed file, check against every glob in `protected_paths`. If ANY file matches ANY protected pattern, call `devspec__fail_work_item` with the matching files listed and EXIT — do NOT commit.

9. **Stage specific files** — NEVER `git add -A` or `git add .`:
   ```
   git add <file1> <file2> ...
   ```

10. **Generate the commit message via MCP** — NEVER self-construct:
    ```
    devspec__generate_commit_message({
      action_item_id: <uuid>,
      summary: "<short imperative summary, <72 chars>",
      type: "feat" | "fix" | "refactor" | "docs" | "test" | "chore"
    })
    ```
    The returned message includes the mandatory `[devspec:<action_item_id>]` tracking tag in the body, which the deployment webhook parses to link deployments back to the item. Hand-crafting would break that link.

11. **Commit** with the generated message:
    ```
    git commit -m "<generated message>"
    ```

12. **Push** (if `auto_push` OR `auto_merge`):
    ```
    git push -u origin {branch_name}
    ```

13. **Merge** (if `auto_merge`):
    - Compute `merge_target` = `target_branch` if non-empty, else `starting_branch`.
    - Validate `merge_target` matches `^[a-zA-Z0-9/_.-]+$`. If it fails, fail the item.
    ```
    git checkout {merge_target}
    git merge {branch_name} --no-ff --no-edit
    git push origin {merge_target}
    ```
    Set `agent_merged = true`.
    **On merge conflict**: `git merge --abort`, then go to Failure Handling.

    If `auto_merge` is NOT enabled, set `agent_merged = false`.

---

## Phase 4 — Report

Call in this order — all three MCP calls are MANDATORY:

1. **`devspec__add_implementation_note`** — final markdown summary: which files changed, what they do, and any decisions made. Substantive, not placeholder.

2. **`devspec__add_commit_reference`** with the full 40-char commit SHA and the generated commit message.

3. **`devspec__complete_work_item`** with ALL of these fields (never skip any):
   - `action_item_id`: the full UUID
   - `commit_sha`: the full 40-char commit SHA
   - `agent_merged`: true/false from Phase 3
   - `affected_files`: array from `git diff --name-only`
   - `completion_note`: 2–3 paragraph markdown — what changed, why, decisions
   - `completion_summary`: 2–4 sentences for non-technical stakeholders
   - `testing_notes`: numbered markdown steps (minimum 3) — reference URLs, UI elements, expected outcomes
   - `usage_notes`: UI navigation path (e.g. "Settings → Integrations"); empty string `""` for non-user-facing changes
   - `verification_report`: `{verification_type: "automated" | "human_required" | "partial", automated_checks_passed: [...], confidence: 0.0–1.0, human_review_needed: [...]}`
   - `provider`: always `"cursor"`
   - `completion_mode`: always `"assisted"` (this is interactive/unattended work, NOT autopilot)

Output a completion banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓  DEVSPEC  ▸  WORK  ▸  COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  item     {title}
  commit   {first 8 chars of sha}
  merged   {yes/no}
  files    {count} changed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Failure Handling

Only applicable when the item was successfully claimed in Phase 3.

1. **Abort in-flight git operations** (best-effort):
   ```
   git merge --abort
   git rebase --abort
   ```

2. **Call `devspec__add_implementation_note`** documenting what was attempted and why it failed.

3. **Call `devspec__fail_work_item`** with:
   - `action_item_id`
   - `error`: description of what went wrong (include which phase/step)
   - `partial_work`: branch name, any partial commits, whether the merge was attempted

4. **Exit** with `✗ Failed: <brief reason>`.

**Never call `fail_work_item` if the claim was never successful** (e.g. 409 Conflict). The item belongs to another runner.

**Vague or ambiguous items**: if the item's description is too vague to implement without guessing, fail with `error: "Requires human judgment — description too vague to implement autonomously"`.

---

## Safety Rules

- **Never ask the user** for input or confirmation in `--unattended` mode.
- **Never `git add -A`** or `git add .` — always stage specific files.
- **Always read** a file before editing it.
- **Never force-push** to any branch.
- **Protected paths are a hard stop** — any match fails the item, no commit.
- **Commit messages MUST use `devspec__generate_commit_message`** — never self-construct. The `[devspec:<id>]` tag is what the deployment webhook parses.
- **One retry max** on any failing command (test, Windows npm shim, 5xx transient).
- **Trim whitespace** from every user-provided field.

---

## Key Details

- **Cursor plugin skill** at `skills/devspec-work/SKILL.md`. Cursor auto-discovers via the `skills/` directory — no explicit path registration needed in `.cursor-plugin/plugin.json`.
- **MCP prefix `devspec__`** — the MCP server is registered as `"devspec"` in `mcp.json`.
- **Differs from `autopilot-process`**: supports item **selection by name/ID** (not just "next queued"), has an optional **brainstorm phase**, uses **`generate_commit_message`** for commits (not hand-crafted), reports **`completion_mode: "assisted"`** (not `"autopilot"`).
