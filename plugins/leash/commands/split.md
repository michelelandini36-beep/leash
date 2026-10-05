---
description: Split an amount between several people and pay each share
argument-hint: <total_usd> <rail> <recipient1,recipient2,...> [memo]
---
The user wants to split a payment: $ARGUMENTS

1. Divide the total evenly between the recipients the user listed (round to cents; give any leftover cent to the first person).
2. Show the plan (who gets how much, on which app) before paying.
3. Call `leash_pay` once per person, with the recipients exactly as the user wrote them.
4. Report each job. If Leash blocks or holds one, keep going with the others and list which ones didn't go through.
