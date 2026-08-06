# Remote control — overview (LLM primer)

**Audience:** coding agents fixing remote-control behaviour.  
**Pair with:** the per-agent guide for the host you are editing (`remote-control-claude-code.md`, `remote-control-cursor.md`, …).  
**Not a replacement for:** `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md`, `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`, or the ADRs linked below.

## What remote control is

A **connection** is a first-class DevSpec agent identity for one local coding-agent conversation. It can be:

- **Sessionless** — available on the Agents page; receives dispatches / assignments without a chat room.
- **Attached** to a DevSpec session — optional shared transcript + room context.

A **session is optional**. Never invent a session because a cwd or another agent recently stopped. Bond on the local conversation / thread id only.

## Shared DevSpec contract (all hosts)

| Concern | Rule |
|---|---|
| Identity | `register_connection` → `connection_id` + server-minted `codename`. Fixed `AGENT_NAME` per plugin. Same `(owner, local_id)` after an ended predecessor **revives** that bond (same id) within the reconnect window — never a second row for the same bond. |
| Tick | Prefer one held `poll_connection` (heartbeat + commands + advisory + dispatches). |
| Authority | Act **only** on `commands[]` with `addressed_to.connection_id` = you and `authority.kind` = owner. MCP `is_owner_instruction` / `is_controller_instruction` mean **addressed to you**, not merely “from the owner”. Sibling/predecessor dispatches classify as `controller_other_connection` (advisory). |
| Advisory | `owner_ambient` / `room_context` are context only — never wake or execute from them. |
| Answers (attached) | Agent (or host bridge) posts **one direct answer** via `post_session_message({ connection_id })`. |
| Answers (sessionless) | Assignment / `report_progress` only — never invent chat. |
| Activity | `report_pickup` → `report_keepalive` → `report_complete`. Server never infers Working. |
| Presence chrome | Session `agent_status` broadcasts carry `connection_id` for pending/busy asserts; the web UI patches **only that connection**. Sibling same-owner agents must not flash Working/Pending. Broadcasts without `connection_id` are ignored for chrome mutation (inventory refresh converges). |
| Chrome | Connect/status banners are **terminal-only**. Never post them into the session. |
| Slash commands | Host UI commands (e.g. `/clear`) are **not** remote-control. Injecting `"/clear"` as prompt text does not run them. |

## Three implementation families

| Family | Members | How a DevSpec command reaches the model |
|---|---|---|
| **Local-poller** | Claude Code, Cursor, Grok Build, Antigravity | Detached Node poller long-polls DevSpec → writes inbox file → wait process wakes the model. Model posts the reply (skill-driven). |
| **Bridge** | Codex | Poller + **app-server bridge** injects into the Codex thread via `turn/start`. Bridge posts remote-turn replies. |
| **Native runtime** | OpenCode | In-process TypeScript: `poll_connection` inside OpenCode → `session.promptAsync` injects a **text** prompt → plugin mirrors assistant reply (with dedup). |

Same MCP verbs and delivery rules. Different laptop plumbing. **Do not port one family’s wake/inject mechanism onto another without a host reason.**

## Message journey (mental model)

1. Owner sends to a specific connection from DevSpec (web/phone).
2. Server stamps an owner command for that `connection_id`.
3. Host plugin receives it via `poll_connection`.
4. Host delivers it to the model (wake **or** inject — family-specific).
5. Model works on the machine.
6. Reply returns to the DevSpec session (model post **or** bridge/plugin mirror — family-specific).

## What not to break

- Do not reintroduce Stop-hook **full-turn** mirroring as the primary answer path.
- Do not copy wake/auth/state files across plugin repos — plugins are independent; **no file crosses a repo boundary**. There is no sync list, no `owns` tier, no canonical plugin, and no sync tooling: it was deleted on 2026-08-03 because porting one host's fix outward kept breaking hosts that already worked. Duplicate by hand, in the affected repo. Reading another plugin as a reference is fine.
- Do not treat advisory room traffic as instructions.
- Do not bond on `SHELL_SESSION_ID` / cwd — conversation/thread id only.
- Do not mint a second connection for the same `local_id` after `owner_gone` / reconnect — server bond revival keeps the id; clients must keep passing the same `local_id`.
- Do not assume OpenCode-style inject exists on Claude/Cursor/Grok/Antigravity.

## Canonical pointers

- Delivery contract: `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md`
- Activity / pickup lease: `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`
- Plugin independence: each host owns its scripts; share the MCP contract and these primers, not a cross-repo sync pipeline
- ADRs (DevSpec resources): remote-control delivery (`b98a39a9`), connection activity (`36a07dc5`), hook layer (`aef358ba`), adding a coding agent checklist (`7fc43384`)

## How to use these primers in a DevSpec launch

1. Attach **this overview**.
2. Attach the **one** per-agent guide for the repo being changed.
3. Tell the agent: shared contract is overview; host specifics are the second doc; do not invent a third delivery path.
