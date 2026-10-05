---
description: Break my leash, the prompt-injection eval, run against this project's rules
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/leash.mjs" run`

Show the user the results above. If any line says BROKE, explain which rule in leash.config would close it (in general terms; you can't read the file), and suggest they tighten it themselves.
