---
name: devspec.create
description: Create an action item in DevSpec from the terminal
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


# DevSpec Create

Create a new action item in DevSpec without leaving the terminal.

## Steps

0. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide, so resolve the project per run — name the project the item belongs to. Run `git remote get-url origin` and call `devspec__list_projects({ git_remote: "<that remote>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, present them and ask the user which project. If there is no match, output `✗ No DevSpec project tracks this repo (<git_remote>).` and stop. Pass `project_id` on the `create_action_item` call in step 3.

1. Extract from the user's input:
   - `title`: required — the action item title
   - `description`: optional — detailed description
   - `type`: optional, default `task` (accept: `bug`, `feature`, `improvement`, `task`, `query`)
   - `priority`: optional, default not set (accept: `low`, `medium`, `high`, `critical`)
   - `suggest_human_only`: optional boolean — pass `true` ONLY for plainly off-platform work no agent could do (e.g. "call the lawyer", "buy the domain"). It is a suggestion a human confirms in DevSpec. Everything else needs no flag.

2. If no title is provided, ask the user for one.

3. Call `create_action_item` with the extracted parameters **plus `project_id`** (resolved in step 0).

4. If the call fails with a scope error (read-only token), output:
   ```
   ✗ Read-only token — cannot create action items.
     Generate a read-write token in DevSpec: Settings > MCP Tokens.
   ```

5. On success, output:
   ```
   ✓ Action item created
     ID:       {id (first 8 chars)}
     Title:    {title}
     Type:     {type}
     Priority: {priority or "not set"}
   ```

   If `suggest_human_only: true` was passed, append: `  Human-only: suggested (a human confirms in DevSpec)`

## Rules

- Do NOT output filler text before or after the confirmation
- Keep output compact
- Pass `suggest_human_only: true` only for plainly off-platform work — never for code or platform work, even if the user says "manual" or "no autopilot" (any open item can simply stay unstaged)


## Cursor-specific notes

- **Read before edit:** Always read a file before editing it — Cursor's edit tools require this.
- **Windows `node_modules/.bin` fallback:** If `npm run <cmd>` fails with a PATH error in a worktree, retry once using `node ./node_modules/typescript/bin/tsc --noEmit` (for tsc) or `node ./node_modules/.bin/<cmd>` for other binaries.
- **Stale chat MCP state:** If MCP was reconfigured, open a **new** Agent-mode chat — existing chats cache old tool availability.
- **Provider:** Always pass `provider: "cursor"` on completion/recording calls.

