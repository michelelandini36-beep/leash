---
description: Leash status: mode, spend in the last 24 h, recent payment jobs
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/leash.mjs" status`

Show the user the output above, unchanged. If a job is `paid`, remind them it settles by itself after 24 h unless they dispute.
