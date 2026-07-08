---
name: devspec.commit
description: Generate a deployment-tracked commit message and execute git commit
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


# DevSpec Commit

Generate a properly formatted commit message with a `[devspec:<id>]` tag for deployment tracking, then automatically execute the git commit.

## Steps

1. **Check for staged changes** — run `git diff --cached --stat`.

2. If nothing is staged, output and stop:
   ```
   ✗ No staged changes. Stage your changes with `git add` first.
   ```

3. **Extract from user input**:
   - `action_item_id`: required — the DevSpec action item ID this commit is for
   - `summary`: required — short summary of what the commit does (under 72 chars)
   - `type`: optional, default `feat` (accept: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`)
   - `body`: optional — longer description for the commit body

4. If action_item_id or summary not provided, ask the user.

5. Call `generate_commit_message` with the parameters.

6. Run `git commit -m "{generated_message}"` using the full message returned by the MCP endpoint.

7. Get the commit SHA with `git rev-parse --short HEAD`.

8. Output:
   ```
   ✓ Committed
     SHA:     {short_sha}
     Message: {subject line}
     Tag:     [devspec:{id}]
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- The MCP endpoint generates the message — do not construct it yourself
- The `[devspec:<id>]` tag in the message is what the deployment webhook uses to track deployments
- If the commit fails (e.g., pre-commit hook), show the error and do NOT retry automatically


## Cursor-specific notes

- **Read before edit:** Always read a file before editing it — Cursor's edit tools require this.
- **Windows `node_modules/.bin` fallback:** If `npm run <cmd>` fails with a PATH error in a worktree, retry once using `node ./node_modules/typescript/bin/tsc --noEmit` (for tsc) or `node ./node_modules/.bin/<cmd>` for other binaries.
- **Stale chat MCP state:** If MCP was reconfigured, open a **new** Agent-mode chat — existing chats cache old tool availability.
- **Provider:** Always pass `provider: "cursor"` on completion/recording calls.

