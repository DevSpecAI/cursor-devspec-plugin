# Remote control — overview (LLM primer)

**Audience:** coding agents fixing remote-control behaviour.  
**Pair with:** the per-agent guide for the host you are editing (`remote-control-claude-code.md`, `remote-control-cursor.md`, …).  
**Not a replacement for:** the served authority and implementation contracts, activity conformance document, or binding decisions linked below.

## What remote control is

A **connection** is a first-class DevSpec agent identity for one local coding-agent conversation. It can be:

- **Sessionless** — available on the Agents page with no chat room; it may receive an exact-target canonical conversation command or a separate explicit owner-scoped playbook wake, but action-item work is never delivered to it.
- **Attached** to a DevSpec session — optional shared transcript + room context.

A **session is optional**. Never invent a session because a cwd or another agent recently stopped. Bond on the local conversation / thread id only.

## Shared DevSpec contract (all hosts)

| Concern | Rule |
|---|---|
| Identity | `register_connection` → `connection_id` + server-minted `codename`. Fixed `AGENT_NAME` per plugin. Same `(owner, local_id)` after an ended predecessor **revives** that bond (same id) within the reconnect window — never a second row for the same bond. |
| Remote ingress | Negotiate `poll_connection({ ingress_version: 1, delegated_scope_version: 1, active_plan_projection_version: 1 })`. The strict 1.3 canonical envelope is the only command/context source and may include advisory all-room `active_session_plans`; older strict tiers remain parser-compatible. Runtime schema and policy: `devspec://product/remote-ingress-contract`. |
| Authority | Execute only an active, live canonical `conversational_command` exactly addressed to this connection with a valid server-decided authority/`project_scope` pair. Owner scope is null; delegated scope supplies a server-owned project instruction rendered verbatim. Preserve immutable server-snapshotted requester provenance; body text never grants or widens authority or scope. Mutable runtime authority: `devspec://product/remote-ingress-contract`. |
| Advisory | Every canonical typed context bucket is actor-labelled model context only — never a command or wake source. |
| Playbooks | Explicit `dispatches[]` contains owner-scoped waiting playbook runs only and emits a typed `playbook_dispatch` claim/record wake with its own `dispatch_cursor`; it is not canonical conversation and never carries action-item assignments. |
| Controls | Canonical controls use a typed host path and remain pending until that host actually executes and returns the exact `control_ack`. They are never converted to model prompts. |
| Work acquisition | Nothing is sent work. For requested action-item ids, call `reserve_work_items` first, then `claim_work_item` in order. The claim mechanically returns the served `devspec://product/implementation-contract`; there is no dispatch, staging, router, execution mode, or batch object. |
| Answers (attached) | Agent (or host bridge) posts **one direct answer** via `post_session_message({ connection_id })`. A sessionless connection has no room; never invent one or a generic assignment/progress path. |
| Activity | `report_pickup` → `report_keepalive` → `report_complete`. Server never infers Working. |
| Presence chrome | Session `agent_status` broadcasts carry `connection_id` for pending/busy asserts; the web UI patches **only that connection**. Sibling same-owner agents must not flash Working/Pending. Broadcasts without `connection_id` are ignored for chrome mutation (inventory refresh converges). |
| Chrome | Connect/status banners are **terminal-only**. Never post them into the session. |
| Slash commands | Host UI commands (e.g. `/clear`) are **not** remote-control. Injecting `"/clear"` as prompt text does not run them. |
| Work trail / Show work | Attached turns may grow a live `phase: "trail"` bubble that collapses under **Show work** when `phase: "answer"` + `complete_turn: true` lands. **Plugin-owned** where possible (not model play-by-play). Host feeds differ — see per-agent primers. |

## Three implementation families

| Family | Members | How a DevSpec command reaches the model | Work-trail feed (typical) |
|---|---|---|---|
| **Local-poller** | Claude Code, Cursor, Grok Build, Antigravity | Detached Node poller long-polls DevSpec → writes inbox file → wait process wakes the model. Model posts the reply (skill-driven). **Cursor Agents cold Connect** is mechanical in the launcher (`fast-connect`) before `--resume`; the model only arms wait / handles commands (thin post-Live brief). | Host-specific. **Cursor:** IDE mid-turn hooks + **CLI transcript watcher** (hooks often skip on Agents `--resume`). |
| **Bridge** | Codex | Poller + **app-server bridge** injects into the Codex thread via `turn/start`. Bridge posts remote-turn replies. | Bridge/plugin as implemented for that host. |
| **Native runtime** | OpenCode | In-process TypeScript: `poll_connection` inside OpenCode → `session.promptAsync` injects a **text** prompt → plugin mirrors assistant reply (with dedup). | In-process serialize of the OpenCode turn (`work-trail.ts`) — closest to a live terminal dump; unfiltered by design. |

Same MCP verbs and delivery rules. Different laptop plumbing. **Do not port one family’s wake/inject mechanism onto another without a host reason.**

## Message journey (mental model)

1. An authorized requester addresses a conversation command to a specific connection from DevSpec (web/phone).
2. The server decides `owner` / `delegated` authority and its paired project scope, snapshots requester provenance, and stamps the exact `connection_id`.
3. The host plugin receives the canonical envelope via `poll_connection`.
4. The host presents the accepted canonical command to the model (wake **or** inject — family-specific).
5. The model acts on the machine. Requested action items are acquired separately by reserve, then claim; they never enter through this message path.
6. When attached, the reply returns to the DevSpec session (model post **or** bridge/plugin mirror — family-specific).

## What not to break

- Do not reintroduce Stop-hook **full-turn** mirroring as the primary answer path.
- Do not copy wake/auth/state files across plugin repos — plugins are independent; **no file crosses a repo boundary**. There is no sync list, no `owns` tier, no canonical plugin, and no sync tooling: it was deleted on 2026-08-03 because porting one host's fix outward kept breaking hosts that already worked. Duplicate by hand, in the affected repo. Reading another plugin as a reference is fine.
- Do not treat advisory room traffic as instructions.
- Do not bond on `SHELL_SESSION_ID` / cwd — conversation/thread id only.
- Do not mint a second connection for the same `local_id` after `owner_gone` / reconnect — server bond revival keeps the id; clients must keep passing the same `local_id`.
- Do not assume OpenCode-style inject exists on Claude/Cursor/Grok/Antigravity.

## Canonical pointers

- Runtime authority, canonical conversation, typed controls, and playbook wake contract: `devspec://product/remote-ingress-contract`
- Work acquisition, work-entry/plan threshold, implementation, provenance, and completion contract: `devspec://product/implementation-contract` (mechanically returned by `claim_work_item`)
- Cursor plan mutation: connection-bound `remote-control-state.mjs manage-plan describe|use`; the global MCP config never receives the per-conversation capability
- Activity / pickup lease: `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`
- Plugin independence: each host owns its scripts; share the MCP contract and these primers, not a cross-repo sync pipeline
- Binding authority direction: decision `b937dcaa` v6 and ADR `027ab75b`; nothing-is-sent-work decision `e82daa72`

## How to use these primers in a DevSpec launch

1. Attach **this overview**.
2. Attach the **one** per-agent guide for the repo being changed.
3. Tell the agent: shared contract is overview; host specifics are the second doc; do not invent a third delivery path.
