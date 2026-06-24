#!/bin/bash
set -euo pipefail
tmp=$(mktemp)
cat > "$tmp"
STATE_DIR="${CLAUDE_PLUGIN_DATA:-${CLAUDE_PLUGIN_ROOT}/hooks/state}"
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/instructions.cjs" user-prompt \
  --project-dir "$CLAUDE_PROJECT_DIR" \
  --state-dir "$STATE_DIR" \
  --input-file "$tmp"
exit_code=$?
rm -f "$tmp"
exit $exit_code
