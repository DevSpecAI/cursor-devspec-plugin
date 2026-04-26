---
name: devspec-brainstorm
description: Run a structured brainstorm session for a DevSpec action item. Explores scope, approach, data, edge cases, dependencies, and acceptance criteria through guided multi-round Q&A. Saves findings as implementation notes. Use when the user wants to brainstorm, think through, or plan an action item before implementing it.
---

# devspec-brainstorm

Run a structured, taxonomy-driven Q&A session for a DevSpec action item and (optionally) save the findings back to DevSpec as an implementation note. **This skill does not implement the action item** — it only explores it. When the user is ready to implement, run the `devspec-work` skill.

MCP tools are the `devspec` server in this plugin's manifest; tool names are prefixed with `devspec__` in this environment (e.g. `devspec__get_action_items`).

---

## Preflight — Verify DevSpec MCP availability

Before resolving the action item, confirm the DevSpec MCP server is actually reachable from this chat:

1. Call `devspec__list_projects` with no arguments.
2. **If it succeeds**, continue to Step 1.
3. **If the call fails, the tool is not available, or any `devspec__*` tool is missing from your tool list**, stop immediately and tell the user:

   > **DevSpec MCP server is not reachable from this chat.** This usually means the chat thread was opened before the MCP server connected — for example, after editing `~/.cursor/mcp.json` or the DevSpec extension settings.
   >
   > **Fix:** Open a brand new Agent-mode chat and re-run this skill. Verify the `devspec` server shows green with all tools listed in **Cursor Settings → MCP & Integrations**.

   Do **not** proceed to brainstorm Q&A or save any notes. Without DevSpec MCP this skill cannot persist findings.

---

## Step 1 — Resolve the action item

1. Extract an identifier from the user's input: a UUID, partial UUID prefix, title, or keywords. If nothing is provided, ask the user for an item name or ID.
2. Call `devspec__get_action_items` with `status: "open"` to fetch candidates.
3. Match the input against `id` and `title` (partial, **case-insensitive**).
   - One match → use it.
   - Multiple matches → show a numbered list (title, status, first 8 chars of `id`) and ask the user to pick one. Example:
     ```
     Multiple matches for "login":
       1. [queued]   Fix login timeout on mobile          (4d753b6a)
       2. [open]     Login analytics dashboard            (f9e8d7c6)
     Pick one (1-2):
     ```
   - No match → tell the user and stop.
4. Once resolved, capture the **complete UUID** as `resolved_action_item_id`. Never truncate, pad, or reconstruct it — always pass the exact string to every subsequent tool call.
5. Load context in parallel:
   - `devspec__get_action_item_history` with `{ action_item_id: resolved_action_item_id }` — prior notes, commit references, activity
   - `devspec__search_memories` with `{ query: "<item title>" }` — related decisions, conventions, risks

Display a one-screen summary of the item before starting the Q&A:

```
━━━ Brainstorm ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title:    {title}
ID:       {first 8 chars}
Type:     {type}
Status:   {status}
Priority: {priority or "not set"}
─────────────────────────────────────────────────────────
{description or "(no description)"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If there are prior implementation notes or related memories, mention counts briefly (e.g. `2 prior notes, 1 related decision`) so the user knows context is loaded.

---

## Step 2 — Multi-round Q&A (the brainstorm loop)

Run an **iterative** loop across these six taxonomy categories. **Never dump all questions at once.** Ask one question, wait for the user's response, then ask the next. Keep it conversational.

### Categories

1. **Scope & Intent** — What exactly needs to change? What is the expected outcome? What is explicitly *not* in scope?
2. **Approach & Alternatives** — What is the proposed implementation strategy? What alternatives were considered? What are the trade-offs?
3. **Data & State** — What data models are affected? What state changes? Are database migrations needed?
4. **Edge Cases & Failure Modes** — What can go wrong? Invalid input handling? Concurrency? Timeout scenarios?
5. **Dependencies & Integration** — What other systems, modules, or teams are affected? API contracts? Breaking changes?
6. **Acceptance & Verification** — How do we know it works? What tests are needed? What does manual verification look like?

### For each category

- Ask **up to 5 focused questions**, one at a time.
- For **every** question, propose a **suggested answer** based on the item description, `affected_files`, prior notes, and any memories loaded in Step 1. Format:
  ```
  {category icon} {category name} — question {n} of 5

  {the question}

  **Suggested:** {proposal} — {1-sentence reasoning drawn from context}

  Agree, adjust, or provide your own answer. (Reply "skip" to skip this question.)
  ```
- User responses are accepted as:
  - `"yes"` / `"agree"` / `"sounds good"` / `"suggested"` → record the suggestion as the answer.
  - Any substantive text → record as the user's own answer.
  - `"skip"` → mark the question skipped.
- Move to the **next category** when the user signals satisfaction (`"next"`, `"move on"`, `"that's enough for scope"`) **or** when all five questions for that category are answered/skipped.
- **Auto-terminate** the loop when all high-impact areas are addressed **or** the user says `"done"`, `"enough"`, `"good"`, `"stop"`, or `"that's it"`.

### Guidance on suggested answers

- Draw from the loaded context: the item `description`, `ai_instructions`, `affected_files`, related memories, prior implementation notes.
- If the item is thin on detail, propose a concrete default ("I'd scope this to the `/auth/login` route only") rather than a vague placeholder.
- When uncertain, say so explicitly in the suggestion and flag it as something to verify during implementation.
- Never invent file paths, function names, or libraries that weren't mentioned in the context. If you need to speculate, mark it as a *guess*.

---

## Step 3 — Compile the brainstorm summary

When the loop ends, compile a **structured markdown summary** of everything captured. Use this exact outline so `devspec-work` and future brainstorm sessions can parse it consistently:

```markdown
## Brainstorm Summary: {item title}

### Scope and Intent
- {key findings from this category}

### Approach
- {chosen approach and reasoning}

### Data and State
- {data model impacts}

### Edge Cases
- {identified edge cases and mitigations}

### Dependencies
- {integration points and concerns}

### Acceptance Criteria
- {verification steps and test requirements}
```

- Use bullet lists under each heading.
- **Bold** key decisions (e.g. "**Chose PATCH over PUT** so partial updates don't nullify other fields").
- Wrap file paths, function names, and identifiers in `backticks`.
- Omit a section entirely if the user skipped every question in that category — do not leave it with a placeholder.
- Keep it scannable. A future reader (or a future agent running `devspec-work`) should be able to understand the plan in under 30 seconds.

Display the compiled summary to the user before Step 4.

---

## Step 4 — Save to DevSpec (optional)

Ask once: `Save this brainstorm to DevSpec? (y/n)`

- **Yes** (or `y` / `save`): call `devspec__add_implementation_note` with `{ action_item_id: resolved_action_item_id, content: <summary> }`. On success output: `✓ Brainstorm saved to DevSpec`. On failure, print the error and offer to copy the summary to the user's clipboard instead.
- **No** (or `n` / `skip` / empty): just keep the summary displayed for the user to copy manually. Output: `(not saved — summary above)`.

Never save without explicit confirmation. This is the one interaction gate in this skill.

---

## Rules

- **Interactive-only.** This skill always requires a human in the loop — there is no `--unattended` mode. If a caller can't interact, return immediately with `✗ devspec-brainstorm requires an interactive session`.
- **Don't implement.** This skill explores and records; it does not edit files, create branches, run tests, commit, push, or call `claim_work_item` / `complete_work_item`. When the user is ready to build, point them at the `devspec-work` skill.
- **Don't leak tool output.** When a tool call fails (e.g. `devspec__search_memories` returns nothing), mention it in one line (`No related memories found — proceeding without prior context.`) rather than dumping raw errors.
- **One question at a time** across the whole Q&A loop. Batching defeats the point of a guided session.
- **Respect the user's pace.** If they type `"skip"`, skip. If they type `"done"`, stop. If they answer with a question of their own, answer it and *then* continue the loop from where you were.
- **Quote user input literally** when echoing it back — do not paraphrase or "clean up" their words.
- **Keep the `resolved_action_item_id` exact** (complete UUID) on every tool call. Never truncate or reconstruct.
- **Suggested answers must be grounded** in loaded context. If context is insufficient, say so and propose a minimal default rather than fabricating specifics.
