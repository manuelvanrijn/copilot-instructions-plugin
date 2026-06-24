---
name: list-copilot-instructions
description: Show loaded GitHub Copilot instruction files, active conditional rules, pending rules, and the current session context paths. Use when debugging copilot instructions or asking which project instructions are active.
allowed-tools: Bash(bash *)
---

# List Copilot Instructions

Run the instruction status check and display the current state.

!`bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/status.sh`

Tell the user:

- Which instruction files are always active
- Which conditional instructions exist and what paths activate them
- Which conditional instructions are active for the current session
- Which paths the current session has accumulated

Do not mention other sessions.
