---
name: autopilot.history
description: Show recent autopilot execution history
---

The DevSpec MCP server is registered as `devspec` in `mcp.json`, so all MCP tool names are prefixed `devspec__`.

---


# Autopilot History

Fetch completed and failed items, then output a clean formatted list.

## Steps

0. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide and no longer pin a project, so resolve which project's history to show. Run `git remote get-url origin` and call `devspec__list_projects({ git_remote: "<that remote>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, ask the user which project. If there is no match, output `✗ No DevSpec project tracks this repo (<git_remote>).` and stop. Pass `project_id` on the `get_action_items` calls below.
1. Call `get_action_items` with `project_id, agent_activity: 'completed'` and `get_action_items` with `project_id, agent_activity: 'failed'` **in parallel**
2. If the completed items response is too large (saved to a file), read the file with the Bash tool
3. Combine all items, sort by most recent first
4. Calculate relative timestamps properly: use the `agent_claimed_at` field (ISO 8601 string). Compute elapsed time using a Bash one-liner if needed:
   ```bash
   node -e "const items = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); items.forEach(i => { const ms = Date.now() - new Date(i.agent_claimed_at).getTime(); const h = Math.floor(ms/3600000); const m = Math.floor((ms%3600000)/60000); console.log(h > 24 ? Math.floor(h/24)+'d ago' : h > 0 ? h+'h ago' : m+'m ago', '|', i.agent_activity === 'completed' ? 'ok' : 'fail', '|', i.agent_branch || 'no-branch', '|', i.title); })"
   ```
   **CRITICAL**: Do NOT use string manipulation or regex to parse dates. Do NOT produce "NaN" timestamps. Always use `Date` constructor on the ISO string.
5. Output the formatted history:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ "Fix login timeout handling"
    autopilot/action-item-a1b2c3d4 · merged · 2h ago

  ✓ "Add input validation to /api/upload"
    autopilot/action-item-e5f6g7h8 · merged · 5h ago

  ✗ "Refactor auth middleware"
    autopilot/action-item-i9j0k1l2 · failed: Merge conflict · 1d ago

  ━━ 3 total · 2 completed · 1 failed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Rules

- Use `✓` for completed, `✗` for failed
- Show branch name, merge status (merged/push-only/failed), and relative time
- For failed items, include the `agent_error` message after "failed:"
- Sort by most recent first
- Show aggregate stats at the bottom
- Do NOT output filler text before or after the banner
- Do NOT use multiple intermediate Bash calls to parse data — compute everything in one pass


## Cursor-specific notes

- **Read before edit:** Always read a file before editing it — Cursor's edit tools require this.
- **Windows `node_modules/.bin` fallback:** If `npm run <cmd>` fails with a PATH error in a worktree, retry once using `node ./node_modules/typescript/bin/tsc --noEmit` (for tsc) or `node ./node_modules/.bin/<cmd>` for other binaries.
- **Stale chat MCP state:** If MCP was reconfigured, open a **new** Agent-mode chat — existing chats cache old tool availability.
- **Provider:** Always pass `provider: "cursor"` on completion/recording calls.

