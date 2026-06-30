---
name: devspec-verify-connection
description: Prove the DevSpec connection loop end-to-end — push a tagged verification commit to each tracked repo's primary branch and report the per-repo result via report_connection_check. Use when the setup wizard asks you to run the DevSpec verify tool with a verification ID, or the user says "verify the DevSpec connection".
---

# DevSpec — Verify Connection

Prove the end-to-end loop the DevSpec setup wizard cares about: that **this agent** can execute a tool, push to GitHub, and have DevSpec receive the webhook — for **every** repo the project tracks. Trigger when the user (or the wizard) says something like `Run the DevSpec verify tool with ID <uuid>`.

This is NOT item verification — it does not touch action items and never calls `devspec__verify_action_item`.

The DevSpec MCP server is registered as `devspec` in `mcp.json`, so all MCP tool names are prefixed `devspec__`.

## Preflight — Verify DevSpec MCP availability

Before parsing the input or doing anything else, confirm the DevSpec MCP server is reachable from this chat:

1. Call `devspec__list_projects` with no arguments.
2. **If the call fails, the tool is not available, or any `devspec__*` tool is missing from your tool list**, stop immediately and tell the user:

   > **DevSpec MCP server is not reachable from this chat.** This usually means the chat thread was opened before the MCP server connected. Open a brand new Agent-mode chat and re-run this skill, and verify the `devspec` server shows green in **Cursor Settings → MCP & Integrations**.

## Input

- **verification-id**: the UUID the setup wizard provides. If missing, ask the user once; if still absent, stop.

## Steps

### 1. Fetch the target repos

Call `devspec__get_project_summary` and read its `repos` array — `[{ id, full_name, target_branch, default_branch }]`. This is the authoritative per-repo branch map. The branch to push for a repo is `target_branch` if set, else `default_branch`, else `main`. Do NOT guess branches or ask the user, and do NOT build a separate fetch.

### 2. Build the verification commit message

Rebuild it from the bare id — do NOT construct your own tag and do NOT use a commit-message generator:

```
chore: verify DevSpec [devspec-verify:<ID>]
```

The `[devspec-verify:<ID>]` marker is what DevSpec matches; it is deliberately different from the `[devspec:<id>]` work-item trailer — never substitute one for the other.

### 3. Find which targets you have locally

For each repo in `repos`, look for a local clone whose `origin` remote matches its `full_name` — check the current workspace folder(s). Compare `git -C '{path}' remote get-url origin` case-insensitively, tolerating a trailing `.git` and ssh-vs-https differences (e.g. `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both match `Org/Repo`).

### 4. Push the tagged commit to each local target

In each matched repo's directory:

```bash
git -C '{path}' fetch origin '{branch}'
git -C '{path}' commit --allow-empty -m 'chore: verify DevSpec [devspec-verify:{ID}]'
git -C '{path}' push origin HEAD:'{branch}'
```

Push to the resolved **target branch** (`HEAD:{branch}`), not the checked-out branch. Record the outcome as `pushed` **only if `git push` exits 0**. If the push is rejected (e.g. non-fast-forward) or errors, record it as `skipped` with a short `reason` — never report `pushed` for a push that did not succeed.

### 5. Record repos with no local clone

For each target you could not find locally, record `skipped` with `reason: "not cloned locally"`. Never silently drop a repo.

### 6. Report back

Call `devspec__report_connection_check` with:
- `verification_id`: the UUID
- `results`: one entry per target — `{ repo: <full_name>, outcome: "pushed" | "skipped", reason?: <string>, branch?: <branch> }`

### 7. Output

```
✓ DevSpec verify
  Pushed:  {N}  →  {repo @ branch}, ...
  Skipped: {M}  →  {repo} ({reason}), ...
```

## Rules

- Reuse the per-repo branch map from `devspec__get_project_summary` — do not invent branches or build a separate fetch.
- The commit tag is `[devspec-verify:<ID>]`, rebuilt from the bare ID — never accept a pre-built message string.
- Only report `pushed` when the push genuinely succeeded (exit 0). A rejected/failed push is a `skipped` with a reason.
- This uses your own git credentials and MCP token — that is the point: it proves the agent's connection, not the human's.
- Distinct from item verification — never call `devspec__verify_action_item` or change any item's `lifecycle`/`agent_activity`.
- Shell safety: wrap interpolated values (verification id, repo path, branch) in single quotes, validate the verification id against `^[0-9a-f-]{36}$`, and reject branch/path values containing shell metacharacters.
