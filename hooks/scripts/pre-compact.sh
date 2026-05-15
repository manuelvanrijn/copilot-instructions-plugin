#!/bin/bash
set -euo pipefail
tmp=$(mktemp)
cat > "$tmp"
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/instructions.cjs" pre-compact \
  --project-dir "$CLAUDE_PROJECT_DIR" \
  --state-dir "${CLAUDE_PLUGIN_ROOT}/hooks/state" \
  --input-file "$tmp"
exit_code=$?
rm -f "$tmp"
exit $exit_code
