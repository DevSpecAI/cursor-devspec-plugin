## Open in Cursor from DevSpec

When you click **Open in Cursor** on the DevSpec web app, DevSpec opens:

`http://127.0.0.1:42731/open?repo=owner/name&prompt=…`

### Automatic setup (recommended)

Installing this extension and connecting DevSpec MCP **automatically**:

1. Copies the open bridge to `~/.cursor/devspec/open-bridge.mjs`
2. Starts it on port **42731**
3. Registers **Windows login startup** so the bridge runs after reboot

You can also run **DevSpec: Install open bridge** from the command palette at any time.

### Manual setup

```bash
npm run open-bridge:install
```

Or double-click `scripts/install-open-bridge.cmd` from the extension folder.

### What happens when you click the rocket

1. Browser hits the localhost bridge
2. Cursor opens the mapped project folder
3. ~1.5s later, Agent chat is pre-filled via `cursor://anysphere.cursor-deeplink/prompt` (you press Enter to send)

### Health check

`http://127.0.0.1:42731/health` should return `{"ok":true}`.

DevSpec never receives or stores your local filesystem paths.
