# DevSpec Autopilot for Cursor

Cursor IDE plugin that connects Cursor's AI agent to the [DevSpec](https://devspec.ai) project management platform via MCP. Pick up queued action items, implement them, run tests, commit with deployment-tracking metadata, and report results back — without leaving the editor.

This is the Cursor counterpart to the [Claude Code](https://github.com/DevSpecAI/claude-code-devspec-autopilot) and [Gemini CLI](https://github.com/DevSpecAI/gemini-cli-devspec-autopilot-extension) autopilot extensions.

## What it does

The plugin registers an MCP connection to your DevSpec workspace and ships five skills the agent invokes contextually:

| Skill | Purpose |
|---|---|
| `autopilot-process` | Fully autonomous: claims the next queued action item, implements it, tests, commits, pushes, merges, reports back. |
| `devspec-work` | Interactive: pick up a specific item by name or ID, optional brainstorm, implement, push, report. Supports `--unattended` mode. |
| `devspec-brainstorm` | Multi-round Q&A to explore scope, approach, edge cases, and acceptance criteria. Saves findings as implementation notes on the item. |
| `autopilot-status` | Show queue counts, in-progress items, push/merge settings, and runner state. |
| `autopilot-history` | Show recent autopilot runs — completed and failed items, timestamps, branches, merge status, errors. |

Commits include a `[devspec:<id>]` tag so DevSpec's deployment webhook can link successful deploys back to the action item.

## Installation

1. Install the plugin in Cursor (marketplace listing forthcoming — for now, clone this repo and install via Cursor's local plugin loader).
2. Set the following environment variables in your shell or Cursor settings:

   ```bash
   DEVSPEC_API_URL=https://app.devspec.ai
   DEVSPEC_MCP_TOKEN=<your DevSpec MCP token>
   ```

   Generate a token from your DevSpec workspace settings.

3. Restart Cursor. The `devspec` MCP server should connect automatically — verify in Cursor's MCP panel.

## Usage

Invoke skills naturally in Cursor's agent chat:

- **"Process the next autopilot item"** → runs `autopilot-process`
- **"Work on the OAuth login bug"** → runs `devspec-work` with that title
- **"Brainstorm the rate-limiting feature"** → runs `devspec-brainstorm`
- **"What's the autopilot queue look like?"** → runs `autopilot-status`
- **"Show recent autopilot history"** → runs `autopilot-history`

## Configuration

`mcp.json` declares the DevSpec MCP server. Environment variables interpolate at runtime:

```json
{
  "mcpServers": {
    "devspec": {
      "url": "${DEVSPEC_API_URL}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${DEVSPEC_MCP_TOKEN}"
      }
    }
  }
}
```

## License

MIT — see [LICENSE](./LICENSE).
