# Leash

**Cash for agents, on a leash.** A Claude Code plugin that lets your agent pay real people on PayPal, Zelle, Venmo, Cash App, Revolut, Wise and more, only the people you allow and only as much as you allow.

> Your agent has the money. Your repo has the rules. Leash has neither.

- The rules live in **`leash.config`**, a file in your repo that the agent's tools are kept away from, and that it can't approve changes to.
- A **PreToolUse hook** checks every `leash_pay` against it and answers **allow**, **ask** (you approve) or **deny**.
- The **MCP server** checks the same rules again and only pays with a fresh receipt from the hook: skip the hook, nothing pays.
- In live mode the money moves through the [nara-agent](https://usenara.cash) network: USDG locks in an on-chain escrow, a human runner pays from their own account, and it settles after 24 h unless you dispute.

## Install

```sh
claude plugin marketplace add michelelandini36-beep/leash
claude plugin install leash@leash
```

Then, in your project:

```
/leash:setup
```

That creates `leash.config` from a template, adds deny rules to `.claude/settings.json` so the agent's file tools can't touch it, and prints one command to run **in your own terminal** to approve (pin) the rules. Until you pin, every payment asks you first.

Requires Node 18+.

## leash.config

```toml
[limits]
per_job_usd = 1000     # network cap 1000
per_day_usd = 1500     # network cap 5000
max_fee_bps = 200      # runner fee cap, 200 = 2% (network cap 5%)

[[allow]]
name    = "landlord"
to      = "@landlord"
rail    = "zelle"
max_usd = 800
every   = "month"      # job (default), day, week or month

[[allow]]
name    = "designer"
to      = "maya@studio.design"
rail    = "paypal"
max_usd = 300

[default]
unknown_recipient = "ask"     # no rule for them: ask | block
from_untrusted    = "block"   # you never typed the recipient: ask | block
over_limit        = "block"   # known, but too much: ask | block
```

How a payment is decided, in order:

1. Valid app, recipient and amount; under `per_job_usd`, `per_day_usd` and `max_fee_bps`. Otherwise **deny**.
2. **Provenance.** The hook reads the session transcript: if you never typed the recipient yourself (it only appears in an issue, PR, web page, file or other tool output), `from_untrusted` applies.
3. A matching `[[allow]]` rule (same recipient, same app) within its `max_usd` for its period: **allow**. Over it: `over_limit`. No rule: `unknown_recipient`.
4. If `leash.config` changed since you last pinned it, an *allow* becomes *ask*.

None of the defaults can be `allow`. The agent is only ever told "allowed", "needs the owner's approval" or "blocked", never the rules.

## Commands

| Command | What it does |
|---|---|
| `/leash:setup` | Create `leash.config`, lock it away from the agent, show the pin command |
| `/leash:status` | Mode, spend in the last 24 h, recent jobs |
| `/leash:dry-run <rail> <to> <amount>` | What the rules would answer, without paying |
| `/leash:run` | **Break my leash**: 10 prompt-injection attacks against your rules |
| `/leash:bounty <pr> <amount> <rail> <to>` | Pay a contributor once their PR is merged |
| `/leash:split <total> <rail> <a,b,c>` | Split an amount and pay each share |
| `/leash:recurring <rail> <to> <amount> <period>` | A rule block to paste, plus how to schedule it |

Plus a `treasurer` subagent for payment work, and MCP tools `leash_pay`, `leash_status`, `leash_release`, `leash_dispute`, `leash_cancel`, `leash_balance`.

## Dry run and live

Leash starts in **dry-run**: jobs are simulated (open → assigned → funded → paid → released), nothing is paid, and dry-run spending is kept apart from live budgets.

To pay for real:

```sh
npm i https://usenara.cash/pkg/nara-agent-0.1.1.tgz   # in your project
export LEASH_MODE=live
export LEASH_AGENT_PRIVATE_KEY=0x...                 # the agent wallet: holds USDG + a little ETH for gas
```

Fees: the runner's fee (capped by you, never above 5%) and a 1% network fee. Limits: $1,000 per job, $5,000 per agent per day.

## What it guarantees, and what it doesn't

- **Can't pay outside the rules without you.** Both the hook and the server have to agree; an "ask" is a Claude Code permission prompt only you can answer.
- **Can't approve its own rules.** Pinning needs an interactive terminal and a typed "yes".
- **Can't quietly change the rules.** Edits through the agent's tools are denied; an edit made any other way un-pins the file, and every payment asks you again.
- **Reading is best effort.** File tools are denied by permissions and the hook, and shell commands that name the file are denied, but a determined shell command could still print it. Knowing the rules doesn't let the agent get around them. For a hard wall, run Claude Code in its sandbox.
- **Don't run payments in `--dangerously-skip-permissions` mode.** "Ask" relies on the permission prompt.

## Develop

```sh
cd plugins/leash && npm test            # rules, hook, server end to end, Break my leash
claude --plugin-dir ./plugins/leash      # try it in a session
```

Leash is not a bank. Runners are independent people paying from their own accounts. Nothing here is financial advice.
