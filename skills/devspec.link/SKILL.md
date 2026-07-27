---
name: devspec.link
description: Link a git commit to a DevSpec action item
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


# DevSpec Link

Associate a git commit with a DevSpec action item for traceability.

## Steps

1. Extract from user input:
   - `commit_sha`: required — the git commit SHA
   - `action_item_id`: required — the DevSpec action item ID
   - `commit_message`: optional — the commit message (auto-detect from SHA if not provided)

2. If either required parameter is missing, ask the user.

3. If commit_message not provided, try to detect it:
   - Run `git log --format="%s" -1 {commit_sha}` to get the message

4. Call `add_commit_reference` with the parameters.

5. If the action item ID is invalid, output:
   ```
   ✗ Action item not found: {id}
   ```

6. If scope error (read-only token):
   ```
   ✗ Read-only token — cannot link commits.
     Generate a read-write token in DevSpec: You → Connections → Connect a tool (Read & write).
   ```

7. On success:
   ```
   ✓ Commit linked
     SHA:    {commit_sha (first 8 chars)}
     Item:   {action_item_id (first 8 chars)}
     Ref ID: {reference_id (first 8 chars)}
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- Accept both full and short SHA formats


## Cursor-specific notes

- **Read before edit:** Always read a file before editing it — Cursor's edit tools require this.
- **Windows `node_modules/.bin` fallback:** If `npm run <cmd>` fails with a PATH error in a worktree, retry once using `node ./node_modules/typescript/bin/tsc --noEmit` (for tsc) or `node ./node_modules/.bin/<cmd>` for other binaries.
- **Stale chat MCP state:** If MCP was reconfigured, open a **new** Agent-mode chat — existing chats cache old tool availability.
- **Provider:** Always pass `provider: "cursor"` on completion/recording calls.

