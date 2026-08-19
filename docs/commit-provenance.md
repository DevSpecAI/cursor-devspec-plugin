# Cursor commit-provenance capabilities

Authority: `devspec://product/implementation-contract` → `commit_provenance_contract`  
Host reference: [Cursor Hooks](https://cursor.com/docs/hooks)

DevSpec's Cursor support is cooperative provenance assistance, not a filesystem,
shell, or Git sandbox. Unsupported and ambiguous surfaces use instructions plus
DevSpec's universal commit ingestion/analyzer.

| Surface | What Cursor honestly exposes | Safe transformation | DevSpec behavior |
|---|---|---:|---|
| Generic edit tools | `preToolUse` and `postToolUse` identify structured tool names/inputs/results | No edit transformation needed | Edits are never denied for claim state. When a concrete edited file path establishes jurisdiction, `postToolUse` may inject one after-the-fact reminder per conversation/project. Missing paths fail open without guessing from the shell cwd. |
| `afterFileEdit` | Absolute path and edit list, after the write | None; Cursor documents no output fields | Telemetry/trail only. It never stops, reverses, or claims to prevent an edit. |
| Arbitrary shell | `preToolUse` exposes structured `Shell` input; `beforeShellExecution` exposes the command string | Cursor supports `preToolUse.updated_input` | Never classify arbitrary shell for mutation authority. Non-commit and opaque commands pass untouched. |
| Commit message inspection | A directly visible Shell command string, not a first-class Git event | Only a narrow invocation with exactly one separate quoted `git commit -m`/`--message` value is readable | A leading `cd <single-path> &&` and `git -C <path>` are readable. Alternate, joined, hidden, or multiple message sources; aliases; extra compounding; expansions; `--no-verify`; amend/history forms; file/editor messages; GUI commits; and every uncertain shape fail open. |
| Commit message transformation | `preToolUse.updated_input` can replace structured Shell input | Exactly one recent, result-confirmed claim can be appended inside a quoted message | The successful DevSpec result must explicitly confirm matching full action-item and project UUIDs. Observations expire after 24 hours; timeless legacy state fails open. A valid full reference does not require a claim. Existing references are never replaced; multiple claims are never guessed. A pending stamp is reported through `postToolUse.additional_context` after execution. |
| Reference existence | A readable message with one well-formed reference can be checked through Cursor's existing MCP transport | No message transformation and no request for missing/newly stamped references | `validate_commit_reference` is bounded to 2.5 seconds. Only definitive `not_found` denies; valid, unavailable, timeout, transport/auth/server errors, malformed results, and indeterminate project outcomes allow. The request uses the parsed commit target's pin, Git remote, and worktree-aware credentials. |
| Commit denial/recovery | `preToolUse` accepts `permission: deny`; a denied tool does not end the conversation | Only readable malformed/multiple references, multiple observed claims, or definitive online not-found have certain local recovery | Denial names the exact recovery and blocks only that tool call. With no observed claim/service evidence, an unreferenced commit fails open to analyzer recovery. |
| Push/outgoing history | Shell command text only; no certain outgoing commit-object set | None | Push is never denied. DevSpec does not require unsafe history rewriting or pretend the command string proves history. |
| Project association | Hook `cwd`, readable command target, nearest `.devspec/project.json`, Git common-directory metadata, and Cursor/project MCP config | None | Local assistance requires a valid full project UUID pin. Linked worktrees inherit the untracked main-checkout pin and may use its `.cursor/mcp.json`/`.mcp.json` credentials before home/fallback credentials. Missing/malformed/unreadable association or auth fails open; `~/.devspec` is never project jurisdiction. Generic connection writes no pin. Ingestion is pin-independent. |
| Offline/server error | Local hook state plus one optional MCP call for an already-present valid reference | None | Edits, execution, unreferenced commits, pushes, worktrees, cross-repository and delegated work continue without a network dependency. Any unavailable/unknown online result allows. State, child-process, or launcher failures emit diagnostics and exit successfully without a hook decision; the 10-second child budget remains below Cursor's 30-second outer hook budget. |
| Session identity | Common hook `conversation_id` / `session_id`, with `CURSOR_CONVERSATION_ID` fallback | None | Claims, pending stamp reports, and the one project nudge are conversation-scoped. Existing remote delivery and the single-enabled-agent no-ID fallback remain unchanged. |
| Installed/live testing | User/project `hooks.json`, stable launcher, and Cursor CLI/IDE hook runtime | `preToolUse`/`postToolUse` behavior can be exercised without a Git hook | Unit tests drive installed routing and real hook envelopes; a Cursor CLI smoke proved the host honored `updated_input`, wrote the stamped commit, and reported the rewritten command through matching `postToolUse`. |

## Why the two worktree forms are readable

The accepted provenance ADR requires isolated worktrees. Cursor sessions commonly
reach one through either:

```sh
cd <single-path> && git commit -m '<message>'
git -C <path> commit -m '<message>'
```

The prefix changes only which checkout receives the same `git commit`; it cannot
change the verb. The recognizer accepts exactly one literal path and no second
separator. It is a commit-message recognizer, not a general shell parser. Cursor
CLI's exact fixed `Co-authored-by: Cursor <cursoragent@cursor.com>` trailer is
accepted because the host adds it automatically and it cannot carry a DevSpec
reference; arbitrary, joined, abbreviated, repeated, or interactive trailer/message
sources remain unreadable and pass untouched.

## Deliberate limits

- Cursor's legacy `beforeShellExecution` hook can deny but cannot transform the
  command. Commit assistance therefore uses the generic structured `preToolUse`
  event and `updated_input` documented by Cursor.
- `afterFileEdit` is fire-and-forget. The bounded edit reminder uses
  `postToolUse.additional_context`, which is explicitly a post-result context
  surface.
- Local full-UUID shape checking remains the first step. Online existence
  confirmation runs only for an already-present valid reference and never turns
  an unavailable or indeterminate server result into denial.
- Authentication, authorization, provider permissions, sandboxing, destructive
  database safeguards, deployment safety, and cost controls are unchanged.
