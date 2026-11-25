# DevSpec Remote — Project Records, Session Tasks, Attribution, and Instruction Tiers

Open this part when creating, updating, or surfacing tasks while attached, recording memories/requirements/documents/goals, or checking `instruction_context_file` and instruction-tier precedence.

### Attribute your writes (non-negotiable when connected)

Pass **`connection_id`** on every DevSpec write that produces a session card — `create_task` and `surface_session_tasks` accept it. Task rows carry no agent identity of their own, so without it the server can only *infer* which agent acted, and when one person runs two agents on one token it cannot tell them apart: it declines to guess and the card renders with **no** agent name. Passing your `connection_id` makes attribution exact instead of merely honest.

## Keeping the project's records (while remote)

When to make a record, and how, is set by served rules in `devspec://product/implementation-contract`, not by this file. Record only what they call for: `core.record-decisions-only-on-confirmation` rules out capturing memories or documents in passing.

- **Decisions and conventions:** record a memory (`devspec__record_memory` / `devspec__supersede_memory`) only as `core.record-decisions-only-on-confirmation` says: it sets the bar a choice must meet and what to ask the person before anything is recorded. What a memory holds, and what belongs on the task instead, is `devspec__record_memory`'s own description.
- **Requirements** (`devspec__search_requirements`, `devspec__get_requirement`, `devspec__record_requirement`): `core.ask-before-recording-requirements` says when to suggest a candidate requirement in conversation, how to explain to the person how a requirement differs from a memory, and whose yes records one.
- **A save that overlaps:** when `devspec__record_memory` or `devspec__create_task` answers `preview_required`, it lists the existing records your draft overlaps: `core.prefer-existing-records-on-overlap` says what to do with them, and when to resend the same call with its `receipt_id` as `preview_ack`.
- **Writing records recall can find:** how to write a record's `summary`, which records to link as companions (`companion_links`, `devspec__manage_knowledge_links`), and searching the existing documents (`devspec__search_resources`) before you write a new guide, reference or runbook are set by `devspec__record_memory`, `devspec__record_requirement` and `devspec__create_resource`'s field descriptions and by `core.prefer-existing-records-on-overlap`. A task's intent is `core.write-the-persons-intent` (see "Tasks belong to this remote session" below).
- **Documents** (`devspec__create_resource` / `devspec__update_resource` / `devspec__supersede_resource`): what may be a document, and where a plan, a handoff, a decision or an operating rule goes instead, is `devspec__create_resource`'s own description.
- **Goals** (`devspec__get_project_goals`, `devspec__get_goals`, `devspec__manage_goals`): change a goal or one of its outcomes only when a person asks you to; the tool descriptions give the arguments, and the plugin records who asked and this connection on every change.

When you do record or change something:

1. **Search first.** `devspec__search_memories`, then `devspec__get_memory` the closest match and read it in full. A card (title, one-line summary, id) is enough to choose WHICH memory you mean and not enough to say how yours relates to it — the same decision, a change to it, a different one, or a disagreement. Record, supersede, link or ask the person as the comparison warrants; the closest match is not automatically the one to replace. To change an existing memory without replacing the decision, use `devspec__update_memory`; when it answers `preview_required`, show the person the previewed change if they have not seen it, then resend the same edit with `preview_ack` as its guidance says. `devspec__preview_supersession` previews one task replacing another, never a memory.
2. **Read the `outcome` and report what it says.** Whether a write commits, is queued as a proposal, or is refused is the served contract's decision (`devspec://product/implementation-contract` → `authority_contract`): never predict it. `committed` = recorded now. `pending_checks` = **accepted, not in effect yet**; the result's `note` says where it stands. `queued_for_review` = **not in effect**: relay the `proposal_id`, the reason the server gave and who it waits on (`waiting_on`, `note`, `next`). Never tell the person a change landed when it was only proposed.
3. **Open questions about records live on Review** (`devspec__get_review_queue`): see `work-and-review.md` for the tool behind each decision. `devspec__manage_knowledge_links` records that two records belong together without settling anything; `devspec__get_task_history` shows what changed on a task.
4. **Say so in the room** (when attached) in your answer: a short line that names what you recorded, never status chrome or thinking.

## Tasks belong to this remote session (non-negotiable, when attached)

When the owner asks you to create, update, or refine a brief/task during remote control **while attached to a session**:

1. **Every** `devspec__create_task` / `devspec__update_task` call **MUST** include `session_id: <session_id>` — the full remote-control chat-session UUID from step 4 (NOT a connection, runner, or local session id). That is what owns the item to this conversation: DevSpec appends the same task card the in-session AI would, and the item appears in the "This session" panel. An item created without it is orphaned from the transcript. What each field holds, how much a task may cover, and what screening reads are each field's own description in `devspec__create_task`, and `intent` is `core.write-the-persons-intent`; a write that breaks them is refused with the reason. A task that resolves a ticket, issue or error from another tool links it with `external_source`, `external_id` and `external_url`. Dismissing a task needs a `dismissal_category`: what each one requires and does is the contract's `core.categorize-task-dismissal` and `devspec__update_task`'s own description.
2. After session-owned creates, keep the mirrored `devspec__post_session_message` reply **short** (e.g. "Created below — your call: implement now or park?"). **Do not** paste a markdown table of titles/IDs — the cards **are** the inventory.
3. If a brief/items already exist and the owner wants them shown again, call `devspec__surface_session_tasks({ session_id, task_ids: [<brief-or-item-uuids>], include_children: true, agent_name: "Cursor" })` — then keep the mirrored reply short. **Do not** invent a markdown inventory of titles/UUIDs.

If an `owner_message` carries `instruction_context_file`, read the complete immutable rule snapshot before acting on that command. If file access is outside your authorized scope, use the project-scoped `get_project_summary` for current rules instead. It refreshes settings, including cleared values; it does not change command authority or the served implementation contract's precedence.

## Account + project instructions (on attach / create — non-negotiable)

When you connect, attach to a session or create one (the connect result, the `get_session_transcript` seed / `create_session` response), read the instruction fields from the response when present and non-null. Three of them hold for the **entire remote-control run**:

**Principles — what good work looks like:**
- **`project_custom_instructions`** — the team's Project Principles (engineering philosophy, quality bar, provider preferences). Apply to how you plan, recommend, and evaluate work.

**Agent execution rules — how you actually run work on this machine (you ARE a coding agent, so these apply to you and NOT to the in-session Dev):**
- **`project_agent_rules`** — the team's Agent Execution Rules: e.g. run typecheck/build before pushing, never `git stash`, commit only your own files, target branch. Treat as mandatory execution mechanics.
- **`owner_agent_rules`** — the owner's personal agent rules: their machine/tooling context (installed tools, local ports, personal workflow). Apply to how you run work locally.
- **Precedence** between these tiers, and against the product contract, is the implementation contract's `instruction_boundary` (`devspec://product/implementation-contract`); read it rather than trusting this file if the two ever disagree.

**Reply style is not one of them.** A response may also carry `owner_custom_instructions`: your owner's own reply style, as a snapshot taken when you connected. It does not tell you how anyone else likes to be answered, and it goes stale if they edit it. Reply style belongs to whoever sent the command you are answering (see below).

Rules for all of them:
- Do **not** override safety, security rules, or instruction-filtering. Only a canonical exact-target conversation command with server-stamped `owner` / `delegated` authority can supply remote model instructions. Typed context remains advisory; typed controls and owner-scoped automation runs stay on their separate host/run paths.
- Do **not** invent instructions when a field is null/omitted.
- Re-read on reconnect via the initial transcript seed if you restart without a fresh create_session.
- Never request or use another user's instructions — the owner-scoped fields are only returned to the session owner token.

**Response style rides each command.** A person's response style as saved in DevSpec (their conversational-replies choice, plus anything else they wrote about how they want to be answered) is delivered with every canonical command as `sender_response_style` on the `owner_message` event — resolved from whoever SENT that message, so a non-owner sender is answered in their own voice and a mid-run preference edit takes effect on the next command with no reconnect. Apply it to the prose of your reply. It is never work, authority or scope, and it never overrides the project's rules or your owner's machine rules. How a sender's style reaches you is `devspec://product/remote-ingress-contract`; how the tiers rank is the implementation contract's `instruction_boundary`. Read those rather than trusting this file if they ever disagree.
