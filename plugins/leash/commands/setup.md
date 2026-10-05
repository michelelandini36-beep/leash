---
description: Set up Leash in this project (creates leash.config and locks it away from the agent)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/leash.mjs" setup`

Show the user the output above as it is. Then, in two or three short sentences:
- leash.config is theirs to edit in their own editor; you can't read it or change it, by design.
- If the output shows a `pin` command, they must run it in their own terminal to approve the rules; until then every payment asks them first.
Do not try to open, read, summarize or edit leash.config yourself.
