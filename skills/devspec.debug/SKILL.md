---
name: devspec.debug
description: Explicitly start, inspect, stop or export local Cursor diagnostics for this connection. Off by default; nothing uploads automatically.
---

# Local Cursor diagnostics

Use only after the person asks to diagnose a problem or explicitly enables debug collection. Do not enable it during routine work, silently for another session, or to manufacture completion evidence.

Resolve this installed plugin's `PLUGIN` root as in `devspec.remote`. Run:

```text
node "$PLUGIN/hooks/scripts/diagnostics-command.mjs" start --minutes 15
node "$PLUGIN/hooks/scripts/diagnostics-command.mjs" status
node "$PLUGIN/hooks/scripts/diagnostics-command.mjs" stop
node "$PLUGIN/hooks/scripts/diagnostics-command.mjs" export
```

The native `CURSOR_CONVERSATION_ID` resolves the connection. From outside that conversation, pass `--connection <exact-connection-uuid>` explicitly; never select a sibling because it appears idle. Start requires an existing local connection. It prints a private directory and readable event file; report the path and expiry to the person. Collection stops automatically after the chosen duration (1–60 minutes, default 15), or immediately with `stop`.

Read the local event file rather than waiting for a remote logging service. It contains safe tool/connect/plugin-MCP timings, failure categories, and metadata-only transcript append observations. An unobserved interval is **unknown**, not automatically model thinking. Native hook availability depends on the actual Cursor host. Calls before enabling diagnostics cannot be reconstructed.

`export` creates a separate sanitized local JSON file. Inspect it before sharing, and upload or attach it only when the person explicitly asks. Never send raw Cursor transcripts, connection state, authentication files, shell arguments or native trace bodies as a substitute. There are no automatic uploads, no diagnostic proxy and no changes to normal polling/resume behavior.

The collector keeps bounded files and at most four runs. Expired retained runs are pruned on the next diagnostic command after 24 hours; no permanent cleanup service is installed. See `docs/remote-control/remote-control-cursor.md` for limits, available sources and runtime verification.
