## Open in Cursor from DevSpec

When you click **Open in Cursor** on the DevSpec web app, DevSpec opens a signed `devspec://` URL (Windows/Linux) or the macOS localhost bridge fallback.

### Automatic setup (recommended)

Installing this extension and connecting DevSpec MCP **automatically**:

1. **Windows / Linux:** registers `devspec://` in the OS (per-user, no admin)
2. **macOS:** starts the localhost bridge on port **42731**
3. Copies the handler to `~/.cursor/devspec/`
4. Runs on demand — no always-on bridge or Windows login startup entry

You can also run **DevSpec: Install protocol handler** from the command palette.

### Manual setup (extension not installed)

**Windows:** double-click `scripts/install-protocol-handler.cmd`

**Linux / macOS:**

```bash
bash scripts/install-protocol-handler.sh
```

### What happens when you click the rocket

1. Cursor opens the mapped project folder.
2. A moment later, the Agent chat is pre-filled with your prompt — press Enter to send.

### macOS health check

`http://127.0.0.1:42731/health` should return `{"ok":true,"mode":"macos_bridge"}` when the fallback bridge is running.

DevSpec never receives or stores your local filesystem paths.

### Signing keys

The handler bundles `scripts/handoff-public-key.pem` for offline verification of the signed handoff.
