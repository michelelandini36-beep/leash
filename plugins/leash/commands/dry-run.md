---
description: Check what leash.config would answer for a payment, without paying
argument-hint: <rail> <recipient> <amount_usd>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/leash.mjs" dry-run $ARGUMENTS`

Show the user the output above, unchanged. Nothing was paid.
