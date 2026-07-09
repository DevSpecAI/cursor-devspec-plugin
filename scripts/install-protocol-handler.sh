#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
node scripts/open-handler.mjs --install
echo ""
echo "DevSpec devspec:// protocol handler installed."
echo "Click the rocket on devspec.ai — allow the browser prompt on first use."
