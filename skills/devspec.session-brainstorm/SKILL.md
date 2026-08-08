---
name: devspec.session-brainstorm
description: Continue a DevSpec chat session locally — either post a one-shot answer back into the session, or brainstorm interactively with the user first and post the agreed conclusion. Invoked by the DevSpec "Continue in Local Agent" handoff.
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


# DevSpec Session Brainstorm

A DevSpec web chat session has been handed off to you locally. Load the conversation, then either **answer** it in one shot or **brainstorm** it interactively — and surface the result back into the session the user is watching, via `post_session_message`.

This command is normally launched by the "Continue in Local Agent" button in the DevSpec chat composer, which passes a `mode` and a `session_id`. It also works when a user types it directly.

## Steps

1. **Parse `$ARGUMENTS`.** Extract three values and store them in working memory:
   - `mode` — from `mode=<value>`. Accept `answer` or `brainstorm`. If the word `brainstorm` (or `interactive`) appears anywhere and no explicit `mode=` is given, treat it as `brainstorm`. **Default: `answer`.**
   - `session_id` — the session UUID, from `session_id=<uuid>` or the first UUID-shaped token in the input. **CRITICAL:** store the **complete UUID** exactly as given (e.g. `e681f85a-bc99-43a3-97fd-7c9c3a57e875`). Never truncate, pad, or reconstruct it — every `post_session_message` call must use this exact string.
   - `topic` — any remaining free text (what the user was thinking about). Optional.
   - If no `session_id` can be found, output `✗ No session_id provided — cannot continue a session.` and stop.

2. **Announce locally (terminal indication).** Immediately print this header so it is obvious a DevSpec session is running:
   ```
   ━━━ DevSpec Session ━━━
   Session:  {first 8 chars of session_id}  (display only — full UUID stored in working memory)
   Mode:     {answer | brainstorm}
   ────────────────────────
   {topic or "No topic provided — see transcript"}
   ━━━━━━━━━━━━━━━━━━━━━━━━
   ```

3. **Signal the web session (web indication).** Right away — before doing any investigation — call
   `devspec__post_session_message(session_id: <session_id>, message: "🖥️ **Local agent connected** — reading the session and investigating the codebase…")`.
   This is what tells the user in the browser that the handoff worked and you are now working. Do this in **both** modes.

4. **Load the conversation.** Call `devspec__get_session_transcript(session_id: <session_id>)` to load what has been discussed so far. Skim it and the `topic` to understand what the user actually wants.

5. **Branch on `mode`:**

   ### mode = answer  (one-shot)
   - Investigate here in this repository — read the relevant code (`Read`/`Grep`/`Glob`, `search_memories`, run read-only commands as needed) to ground your answer in the real codebase.
   - When you have findings, post them back **once**:
     `devspec__post_session_message(session_id: <session_id>, message: <your findings as markdown>)`.
   - Use clear markdown — a short summary line, then specifics (files, `code`, bullet lists). Post directly to the session; do not leave comments on items. Create action items only when the session conversation explicitly asks for them — and then follow the **Action items belong to the session** rule below.
   - Then output a local confirmation and **stop** (see Output).

   ### mode = brainstorm  (interactive)
   - Do **not** post conclusions yet. Brainstorm *with the user, here in the terminal*, grounded in the transcript and the code.
   - Investigate enough to ask sharp questions, then ask in **rounds of up to 5**, drawn from this taxonomy (pick the biggest gaps first):
     - **Scope & Intent** — core problem, who benefits, what's out of scope
     - **Approach & Alternatives** — strategies, tradeoffs, existing patterns to follow/avoid
     - **Data & State** — data changes, migrations, new entities, side effects
     - **Edge Cases & Failure Modes** — invalid input, concurrency, rate limits, timeouts
     - **Dependencies & Integration** — other systems/APIs/action items, downstream breakage
     - **Acceptance & Verification** — definition of done, what a tester checks, logs/metrics
   - For each question: analyze the code/transcript, propose a recommended answer, then ask. Format:
     `**Suggested:** <proposal> — <1-sentence reasoning>` then `Agree, adjust, or give your own answer.`
     Accept on "yes"/"agree"/"suggested"; "skip" moves on. Record each accepted answer in working memory.
   - **After each round:** if all high-impact areas are covered, say `All key areas covered — ready to post the summary.` Otherwise ask `Continue brainstorming? (y/n)`.
   - **Early exit:** on "done"/"good"/"that's it"/"stop", end the loop immediately.
   - When the loop ends, compile a structured summary:
     ```markdown
     ## Brainstorm Summary
     **Scope:** <1-2 sentences>
     **Approach:** <chosen strategy + key tradeoffs>
     **Edge Cases:** <bullet list>
     **Acceptance Criteria:** <bullet list of verifiable conditions>
     **Open Questions:** <anything unresolved, if any>
     ```
   - Show it in the terminal, then ask: `Post this summary back to the DevSpec session? (y/n)`
     - If **yes**: `devspec__post_session_message(session_id: <session_id>, message: <the summary>)`.
     - If **no**: do not post; tell the user the summary is above if they want it later.
   - **Action items.** If the brainstorm produced concrete work, list the proposed items in the terminal and ask: `Create these as DevSpec action items? (y/n/pick)`. On agreement, create each with `create_action_item` — **always passing `session_id: <session_id>`** so the item is owned by this session (it appears in the session transcript as an action-item card and in the "This session" panel automatically — so the posted summary can reference items briefly instead of re-listing their full details). Same for `update_action_item` on existing items the discussion refined: pass `session_id: <session_id>`.
   - **Durable knowledge.** If the discussion settled something durable about the *project* — a decision, convention, architecture fact, or risk that outlives this session — persist it with `record_memory` (`search_memories` FIRST; `supersede_memory`/`retract_memory` the stale match instead of duplicating. `search_memories` returns a CARD (title, one-line summary, id), so `get_memory` the match and read it in full before superseding: a card is enough to choose WHICH memory you mean, not enough to justify replacing it.; shared knowledge only, not transient or obvious details — don't record aggressively). DevSpec memory is the team's **shared** source of truth, distinct from your own local memory (your own local Cursor rules / notes) where personal or machine-specific notes belong — keeping that boundary is what stops DevSpec going stale.

**Memory or rule?** The boundary above does not settle this — a rule is durable and shared as well. Ask what the thing IS: a decision with a reason someone may revisit is a **memory**; a standing instruction to act on every time is a **rule** (`devspec__write_project_instruction_rule`). A rule recorded as a memory is one nobody follows. Report a rule write by its returned `outcome` — `queued_for_review` is not in force until a maintainer accepts it.
   - Then output a local confirmation and stop (see Output).

## Output

On success, print:
```
✓ Posted to DevSpec session
  Session:  {first 8 chars of session_id}
  Mode:     {answer | brainstorm}
```
If in brainstorm mode the user declined to post, replace the first line with `↻ Not posted — summary is above if you need it later.`

## Rules

- Post the "Local agent connected" signal (step 3) **before** investigating, in both modes — it is the user's only indication the handoff worked.
- In **brainstorm** mode, never post a conclusion to the session until the user has finished brainstorming and agreed to post. In **answer** mode, post exactly one findings message.
- Always use the full `session_id` UUID stored in step 1 — never reconstruct or pad it.
- Ground everything in the actual transcript and codebase — no generic advice.
- **Action items belong to the session.** Never create or update an action item from this command without the user's agreement (brainstorm mode) or the session explicitly asking for it (answer mode). When you do, **every** `create_action_item` / `update_action_item` call MUST include `session_id: <session_id>` (the full chat-session UUID from step 1 — NOT a runner or local session id). That is what makes the item owned by the session: it shows up in the session's transcript and "This session" panel. An item created without it is orphaned from the conversation that produced it.
- Keep terminal output tight — no filler before or after the structured blocks.


## Cursor-specific notes

- **Read before edit:** Always read a file before editing it — Cursor's edit tools require this.
- **Windows `node_modules/.bin` fallback:** If `npm run <cmd>` fails with a PATH error in a worktree, retry once using `node ./node_modules/typescript/bin/tsc --noEmit` (for tsc) or `node ./node_modules/.bin/<cmd>` for other binaries.
- **Stale chat MCP state:** If MCP was reconfigured, open a **new** Agent-mode chat — existing chats cache old tool availability.
- **Provider:** Always pass `provider: "cursor"` on completion/recording calls.

