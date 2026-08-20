# Remote control — Cursor (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `cursor-devspec-plugin` (VSIX; hooks under `hooks/scripts/`).  
**Operational runbook:** plugin skill `skills/devspec.remote/SKILL.md` (manual Connect + post-Live; Agents launches use mechanical Connect + thin brief).

## Cold Connect is mechanical (plugin-owned)

On **Agents CLI / protocol handoff** (`launch-cli-session.mjs`), Connect no longer asks the model to walk `register_connection` / `attach_connection`. After `agent create-chat` and **before** `agent --resume`, Node runs **fast-connect**:

1. Resolve `local_id` (chat id / `CURSOR_CONVERSATION_ID`)
2. Resolve project (`git remote` + `list_projects`)
3. `register_connection`
4. `attach_connection` when the launch prompt has `--session <uuid>`
5. Write connection state (**poller deferred** — no durable owner PID exists yet)
6. Stamp a **thin post-Live brief** (PLUGIN= + bond IDs + arm-wait / answer / re-arm) — **not** the full ~32k skill body
7. Spawn `agent --resume`, then `ensure-poller` anchored to a durable host **in that child tree** (`cursor-agent` node.exe / `agent.exe`). Walking ancestors of `launch-cli-session` cannot see the CLI agent; pinning to `Cursor.exe` (the IDE) would not reap when the terminal closes (item f099fc6e).

The model’s job after resume: arm wait (`--from-end`), handle owner commands, post answers, re-arm (`--pending --after-reply`). `--from-end` skips advisory inbox history but **does not** skip `owner_messages` the poller already queued (item 1f177af4). Do **not** re-register on a stamped “already Live” launch.

**Launcher path (item 94b11df6):** `open-handler --install` / extension activate writes `~/.cursor/devspec/extension-root.json`. Protocol CLI launches resolve `launch-cli-session.mjs` in this order: **extension scripts/** (marker) → installed `~/.cursor/devspec` copy → sibling of the handler module. A stale installed copy must never shadow mechanical fast-connect after a VSIX update.

**Invoke fast-connect manually:**

```bash
node "$PLUGIN/hooks/scripts/remote-control-state.mjs" fast-connect \
  --local-id "<chat-id>" \
  [--session "<uuid>"] \
  [--cwd "$(pwd)"] \
  [--launch-id "<uuid>"] \
  [--project-id "<uuid>"] \
  [--prompt-file path/to/launch.prompt.txt]
```

JSON stdout: `connection_id`, `session_id`, `codename`, `local_id`, `launch_id`.

Manual `/devspec.remote` in an already-open chat still uses the skill; prefer `resolve-local` → `already_live` (re-arm only) or the Node `register` / `attach` helpers when cold.

## How a message reaches Cursor

1. An authorized requester sends a canonical conversation command exactly to this connection in DevSpec.
2. The server decides `owner` / `delegated` authority, snapshots immutable requester provenance, and returns the canonical envelope to detached `devspec-remote-poll.mjs`.
3. The poller validates the exact target and complete envelope, then writes the accepted command turn to the inbox.
4. `devspec-remote-wait.mjs` runs **one-shot** (no `--stream` in the Cursor plugin copy) and exits on the canonical command; Cursor notifies the Agent chat on matching stdout.
5. Model acts; when attached, model `post_session_message({ connection_id, phase: "answer", complete_turn: true })` on the **final** answer (omit `complete_turn` on any rare mid-turn narrative posts — **trail is plugin-owned**).
6. Model **must re-arm** wait with `--pending --after-reply` after the reply (never `--from-end` on re-arm) — backstop for Working clear + local turn marker.

### Wake stdout (what you see when wait exits)

Cursor negotiates canonical v1 ingress. The runtime schema, version, wake, authority, attachment, and bounded-window rules live at `devspec://product/remote-ingress-contract`; operational prose does not duplicate them.

Wait emits exactly one accepted unit per one-shot arm. Canonical conversation turns use this order:

1. Optional `{ "type": "model_context", "advisory": true, "typed": { … }, "windows": […], "locally_omitted": N }` — all four actor-labelled context buckets, inert.
2. One or more `{ "type": "owner_message", "session_id": "…", "message": { … } }` — complete command records with full bodies and delivery metadata.
3. `{ "type": "wake", "reason": "canonical_conversational_command", "envelope_id": "…", "turn_id": "…" }` — the complete turn boundary.

Explicit `dispatches[]` playbook runs use a separate owner-scoped `playbook_dispatch` + `wake(reason: "playbook_dispatch")` path with their own requester snapshot and typed claim/record lifecycle; they are never canonical conversation or action-item assignment. Canonical controls use a separate typed host-control ledger. Cursor currently exposes no safe in-process lifecycle control API, so those verbs remain unacked rather than being converted to model prompts; `control_ack` is authorized only after a real host handler succeeds.

The poller persists `cursor_v2` as the live forward cursor, `window.next_cursor` as `catch_up_cursor` for older pages, and `dispatch_cursor` as the playbook watermark. Older-page draining never rewinds the live cursor. Stable command-turn/playbook keys make inbox acceptance replay-idempotent, and wait validates the full canonical envelope again before emission.

The wait byte cursor advances only after all events are flushed. A queued second unit remains for the next one-shot re-arm. Prefer `post_session_message({ connection_id, … })` so the server resolves the current attachment.

### Work acquisition is not ingress

Nothing sends action-item work to Cursor. When an owner asks the agent to work item ids, the agent calls `reserve_work_items` for those ids first, then `claim_work_item` in order. Claim mechanically returns the served `devspec://product/implementation-contract`; it governs implementation and completion. There is no work dispatch, staging, router, execution mode, or batch object, and neither canonical conversation nor `playbook_dispatch` carries an action-item assignment.

### Owner attachments

Canonical `metadata` attachments remain stable `resource_id` references (`delivery: "resource"`); no transcript recovery or local base64 materialisation is required. An `unavailable` attachment rejects its command before wake. See `devspec://product/remote-ingress-contract`.

## Why one-shot here

Cursor has no Claude-style persistent Monitor for session-scoped stdout wakes. Exit-to-notify is the working host pattern. That makes **re-arm mandatory**; forgetting it leaves the connection Live but deaf.

## Turn end / Working indicator

Working (dots / logo spinner) is driven by connection activity + busy, seeded by the per-connection `.turn` marker the poller writes on owner-command delivery.

**Work-trail bubble (OpenCode-shaped UI, dual feed):** while attached, the plugin posts `phase: "trail"` mechanically — seed `"Working…"` on `user_prompt` **and** on remote owner-command delivery in `devspec-remote-poll` (phone/web wakes never hit Cursor's user_prompt hook). Growth has **two** paths:

| Feed | When it runs | Source |
|---|---|---|
| **IDE hooks** → `trail-turn.mjs` | Cursor IDE Agent fires mid-turn hooks | `postToolUse` / shell / file / MCP / optional `afterAgentThought` |
| **CLI transcript watcher** → `cli-trail-watch.mjs` | Agents CLI (`agent --resume`) — mid-turn hooks often **never fire** (session `7f252f37`, item `63f3db87`) | Tails `~/.cursor/projects/*/agent-transcripts/<local_id>/<local_id>.jsonl`; poller starts the watcher on attached pickup |

Both use the same throttle/hash/cap helpers in `work-trail.mjs`. The live bubble collapses under **Show work** when the model posts `phase: "answer"` with `complete_turn: true`. Do **not** make model-pushed trail the primary path.

| Path | When | Clears Working? |
|---|---|---|
| `post_session_message({ phase: "answer", complete_turn: true })` | Final agent answer (same MCP request as the bubble) | Yes — **preferred**: activity complete + `busy:false` broadcast with the insert so phone/web clear when the answer lands (item d4014e58). Mid-turn progress posts omit the flag (item 5e7aac1c) |
| Stop hook → `mirror-turn.mjs stop` | IDE Agent turn end (when hooks fire) | Yes — clears marker **and** immediately `report_complete` + `busy:false` (+ clears local `.trail.json`) |
| Wait `--pending --after-reply` | After the model posts the reply and re-arms (Cursor skill) | Yes — **backstop on Cursor CLI** (Stop often never fires): clears marker **and** immediately `report_complete` + `busy:false` (item cd989606). Without `complete_turn` on the post, this is what ends Working (~agent overhead + MCP RTT after the bubble) |
| Wait plain `--pending` | Mid-turn re-arm only | **No** — keeps Working (item 68f7b30c) |
| Wait `--from-end` | First arm after connect | Yes — clears seed/phantom markers **and** immediately completes any leftover working attempt. Offset skips advisory history but keeps unread `owner_messages` already in the inbox (item 1f177af4) |
| `MAX_TURN_MS` (1h) | Poller backstop | Yes — last resort |

Do **not** clear Working on interim `post_session_message` alone (omit `complete_turn` — item 5e7aac1c). Do **not** clear on plain `--pending` re-arm.

**Re-arm rule of thumb:** mid-turn / early re-arm → `--pending` only. After the final answer → `--pending --after-reply`. Never pass `--after-reply` while still working.

**Why `complete_turn` on the final post:** ending Working only via wait `--after-reply` still leaves dots for several seconds after the answer bubble (post → agent re-arm → MCP complete). Ending in the same `post_session_message` request clears them with the bubble. Keep `--after-reply` as the backstop for clients that have not adopted the flag yet.

## Host specifics

| Topic | Cursor |
|---|---|
| Invoke remote | Agents launch: mechanical fast-connect + thin brief. Manual: `devspec.remote` skill / Agent prompt (IDE) |
| Bond id | Prefer `CURSOR_CONVERSATION_ID` or explicit `--local-id`; shell often lacks it — do not silently mint then lose the bond |
| Token | Plugin-owned `resolve-mcp-auth.mjs` — lookup order: env → project `.cursor/mcp.json` → `~/.cursor/mcp.json` → walk `.mcp.json` (not Claude plugin env) |
| Agent name | `AGENT_NAME = 'Cursor'` |
| Owner pid | Prefer omit or `"$PPID"`; on Windows the write path self-resolves up to `Cursor.exe` / CLI `agent.exe` / `claude.exe`, or `node.exe` hosting cursor-agent `--resume` (Cursor CLI often has no `agent.exe` — item c57dc381). **Never** pin to `index.js worker-server` — that child exits while `--resume` lives and fires `owner_gone` (item 5c884554). **Never** pass tool-shell `$PID` (`powershell` / `pwsh` / `cmd` / `bash`) — those exit when the tool call ends and fire `owner_gone` (item f3a88333). Invalid MSYS `$PPID` is ignored and self-resolved. |
| Mirror / trail hooks | `~/.cursor/hooks.json` points at **stable** `~/.cursor/devspec/hooks/run-mirror-turn.mjs`, which resolves the newest installed VSIX each run (never pin a versioned extension path). Modes: `user_prompt` / `stop` → `mirror-turn.mjs`; mid-turn modes → `trail-turn.mjs` |
| CLI trail feed | Cursor Agents CLI (`agent --resume`) often **does not** invoke mid-turn hooks. On attached owner-command pickup the poller starts `cli-trail-watch.mjs`, which tails `~/.cursor/projects/*/agent-transcripts/<local_id>/<local_id>.jsonl` and posts throttled `phase=trail` until the turn marker clears. Hook path stays for IDE; transcript watcher is the CLI-safe path (item 63f3db87). |
| PLUGIN pin (Agents launch) | Cold Agents launches stamp `PLUGIN=<extension-root>` via `scripts/pin-remote-plugin.mjs` (also copied to stable `~/.cursor/devspec/pin-remote-plugin.mjs`). Resolution uses **semver** (`parseExtensionVersion` / `compareSemverTuples`) — never lexicographic folder sort (`0.4.9` wrongly beat `0.4.14` before item `0688ff96`). Connect stamps a **thin post-Live brief**, not the full skill. |

## What not to change lightly

- Copying Claude’s `--stream` wait into Cursor — there is no Monitor primitive here, and no file crosses a repo boundary anyway.
- Overwriting Cursor’s auth resolver with Claude’s.
- Using `--from-end` after the first arm (drops pending inbox mail). First-arm `--from-end` itself must not seek past unread `owner_messages` the poller already wrote (item 1f177af4).
- Re-arming with plain `--pending` after a finished reply (leaves Live-but-Working forever on CLI).
- Hand-writing connection JSON with a hardcoded prod MCP URL.
- Pointing hooks.json at `…/extensions/devspecai.devspec-autopilot-<version>/…` (dies on every VSIX bump).
- Sorting installed extensions by folder-name string order when picking PLUGIN (pins stale patch versions).
- Assuming CLI mid-turn hooks fire because IDE hooks do — always keep the transcript watcher for Agents attaches.
- Re-introducing LLM-walked register/attach on cold Agents Connect (mechanical fast-connect owns that).

## Failure modes

- Missed re-arm after answering → next owner message never wakes.
- Final answer without `complete_turn: true` → dots linger ~agent overhead + MCP RTT after the bubble until `--after-reply` completes (d4014e58).
- Re-arm without `--after-reply` after a reply → Working/dots stuck if the post also omitted `complete_turn` (CLI).
- Re-arm with `--after-reply` that only clears the local marker (no `report_complete`) → dots linger one long-poll (~30s) after the reply — fixed by `notifyWorkingEnded` in wait (cd989606).
- Stale notifications from a previous wait process → check whether the command was already answered before redoing work.
- Wrong local_id mint vs conversation id → duplicate connections / Resume empty.
- Tool-shell `$PID` as `--owner-pid` on Windows → poller dies with `owner_gone` mid-session; reconnect without bond revival used to mint a new connection and orphan exact-target commands.
- Version-pinned hook path → Stop never runs; Working and local-prompt mirroring go silent.
- Lexicographic PLUGIN pin → Agents relaunch keeps an older VSIX (e.g. 0.4.9 over 0.4.14/0.4.15) even after install (item 0688ff96).
- CLI Show work stuck at a one-liner / seed only → mid-turn hooks not firing; confirm poller is 0.4.15+ and `cli-trail-watch` starts on pickup (item 63f3db87).
- Wait exit **1** after a host/redeploy-shaped end (not UI `end_reason` / local stop) → re-register the **same** `local_id` and re-arm (see skill); standing down orphans the bond.
- Ignoring canonical `attachments[].resource_id` on `owner_message` → miss a stable referenced resource that is part of the command.
- Fast-connect abort (auth / project / register / attach) → launcher exits **before** `--resume` (no half-Live agent). Missing owner-pid at pre-resume poller time is **not** fatal; poller starts after spawn (item f099fc6e).
- Mechanical Connect `ensure-poller` before `--resume` on Windows → refuse owner-pid, launcher exits, connection idle_timeout (Restless Owl). Fixed in 0.5.2: defer poller until the CLI child tree exists.
- First canonical command after Connect skipped (Emerald Ocelot). Wait `--from-end` seeked to EOF past `owner_messages` the poller already queued. Fixed in 0.5.3: skip advisory history only (item 1f177af4).
- Poller `--owner-pid` pinned to cursor-agent `index.js worker-server` → `owner_gone` while `agent --resume` is still alive (Copper Sparrow / Azure Bison / Azure Raccoon). Fixed in 0.5.4: skip worker-server; pin to `--resume` (item 5c884554).

## Key files

- `scripts/launch-cli-session.mjs` (create-chat → **fast-connect (no poller)** → thin stamp → `--resume` → **ensure-poller** from child tree)
- `hooks/scripts/fast-connect.mjs` (mechanical Connect orchestrator)
- `scripts/pin-remote-plugin.mjs` (PLUGIN= + thin post-Live brief)
- `hooks/scripts/devspec-remote-poll.mjs`
- `hooks/scripts/devspec-remote-wait.mjs` (one-shot; `--after-reply` turn-end; attachment materialisation)
- `hooks/scripts/run-mirror-turn.mjs` (stable hook launcher — also dispatches trail modes)
- `hooks/scripts/mirror-turn.mjs` (Stop / user_prompt — seeds trail; Stop clears turn + trail state + `report_complete` when hooks fire)
- `hooks/scripts/seed-work-trail.mjs` (shared `phase=trail` Working… seed used by mirror + poller)
- `hooks/scripts/trail-turn.mjs` (mid-turn `phase=trail` posts)
- `hooks/scripts/cli-trail-watch.mjs` (CLI transcript-tail trail; started by poller on pickup)
- `hooks/scripts/post-trail-from-transcript.mjs` (shared transcript → phase=trail poster)
- `hooks/scripts/work-trail.mjs` (throttle / render / transcript helpers)
- `hooks/scripts/remote-control-state.mjs` (`register` / `attach` / `write` / `fast-connect`)
- `hooks/scripts/resolve-mcp-auth.mjs` (**plugin-owned**)
- `hooks/scripts/agent-identity.mjs`
- `hooks/scripts/connect-phase-timing.mjs` (dense `connect_phase` → Axiom)
- `hooks/scripts/remote-control-story.mjs` (shared phase vocabulary + local `story ` emitter)

## Logging — reconstructing a connection story

Fragile remote sessions are debugged from two places that share one phase vocabulary:

| Source | Where | What |
|---|---|---|
| **Axiom (server)** | DevSpec MCP tool logs | `msg == "Remote-control story"` with `connectionId`, `sessionId`, `data.phase`, `data.outcome`, `reason` |
| **Axiom (client phases)** | Plugin POST `/api/log` | Same message; payload under `['data']['client']` with `kind == "connect_phase"`, `duration_ms`, `launch_id` (item 383de0cd / mechanical Connect) |
| **Local poll.log** | `~/.devspec/remote-control/connections/<connection_id>.poll.log` | Poller stderr/stdout (spawn redirect). Structured lines prefixed `story ` plus human poller messages. Kept for offline debug. |

**Shared lifecycle phases:** `register` · `attach` · `seed_filter` · `inject` · `wake` · `mirror_decision` · `mirror_post` · `complete_turn` · `pickup` · `done` · `poll_error` · `stall` · `ended`

**Cold-launch / connect timing phases** (Node-measured): `create_chat` · `expand_stamp` / `skip_stamp` · `write_stamp` · `agent_resume` · `resolve_local_id` · `resolve_local` · `project_resolve` · `register_connection` · `attach_connection` · `write_state` · `ensure_poller` · `wait_armed`

Cursor emits client-side stories from `devspec-remote-poll.mjs` (seed filter, **`inject`** = inbox write, wake, poll errors, max-turn stall) and `mirror-turn.mjs stop` (`complete_turn`). Launcher + connect timings ship via `connect-phase-timing.mjs` → `/api/log`. The agent’s `post_session_message` path is covered by server breadcrumbs after staging deploy.

**Axiom recipe** — connection lifecycle (dataset `devspec`):

```
['devspec']
| where message == "Remote-control story" or ['data']['client']['kind'] == "connect_phase"
| where connectionId == "<connection-uuid>" or ['data']['client']['connectionId'] == "<connection-uuid>"
| sort by _time asc
| project _time, message, source, ['data'], connectionId, sessionId
```

**Axiom recipe** — one cold launch timeline by `launch_id` (primary Connect debug):

```
['devspec']
| where ['data']['client']['kind'] == "connect_phase"
| where ['data']['client']['launch_id'] == "<launch-uuid>"
| sort by _time asc
| project _time,
    phase = ['data']['client']['phase'],
    outcome = ['data']['client']['outcome'],
    duration_ms = toint(['data']['client']['duration_ms']),
    connectionId = ['data']['client']['connectionId'],
    local_id = ['data']['client']['local_id'],
    reason = ['data']['client']['reason']
```

The stamped prompt and launcher log print `launch_id=…` so you can paste that UUID into the filter. Expect a dense chain: `create_chat` → `project_resolve` → `register_connection` → optional `attach_connection` → `write_state` → `ensure_poller` → `expand_stamp` → `write_stamp` → `agent_resume` (then model-side `wait_armed`).

**Local recipe:** open the connection’s `.poll.log` and grep `story `. Do not dump model token streams into either log.
