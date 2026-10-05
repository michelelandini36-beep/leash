---
description: Set up a recurring payment (rent, a retainer, a subscription to a person)
argument-hint: <rail> <recipient> <amount_usd> <day|week|month>
---
The user wants a recurring payment: $ARGUMENTS

You can't edit leash.config, so do this:
1. Give the user this block to paste into leash.config themselves (fill in the values from their arguments):

```
[[allow]]
name    = "<short name>"
to      = "<recipient>"
rail    = "<rail>"
max_usd = <amount_usd>
every   = "<day|week|month>"
```

2. Tell them to approve the new rules with the pin command from /leash:setup.
3. Suggest scheduling it with Claude Code (for example `/schedule` or `/loop`) using a prompt that names the recipient and amount, like: "Pay <recipient> $<amount> on <rail> for <what>". The rule caps it at $<amount> per <period>, so a second run in the same period is blocked.
