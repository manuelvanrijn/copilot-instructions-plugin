#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$SCRIPT_DIR/..}/state"
node "$SCRIPT_DIR/instructions.cjs" status \
  --project-dir "$PROJECT_DIR" \
  --state-dir "$STATE_DIR"
