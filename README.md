# Leash

[leashcash.com](https://leashcash.com) · [Docs](https://leashcash.com/docs/) · [Runner desk](https://leashcash.com/runner/)

**Cash for agents, on a leash.** A Claude Code plugin that lets your agent pay real people on PayPal, Zelle, Venmo, Cash App, Revolut, Wise and more, only the people you allow and only as much as you allow.

> Your agent has the money. Your repo has the rules. Leash has neither.

- The rules live in **`leash.config`**, a file in your repo that the agent's tools are kept away from, and that it can't approve changes to.
- A **PreToolUse hook** checks every `leash_pay` against it and answers **allow**, **ask** (you approve) or **deny**.
- The **MCP server** checks the same rules again and only pays with a fresh receipt from the hook: skip the hook, nothing pays.
- In live mode the money moves through the **Leash network**: the agent's USDG locks in the LeashEscrow contract on Robinhood Chain, a human runner pays from their own account, and it settles after 24 h unless you dispute.

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
max_fee_bps = 500      # runner fee cap, 500 = 5% (the network cap)

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

## Review rule changes in pull requests

The hook keeps the agent from editing `leash.config` on your machine. But agents also open pull requests, from the cloud or from CI. **Leash review** is a GitHub Action that watches every PR touching `leash.config`:

- it explains each change in plain words, and whether it makes the leash **looser** or **tighter**;
- it runs Break my leash on the new rules;
- if the leash gets looser, the check fails until one of the owners approves the PR (and never the PR's own author).

Add `.github/workflows/leash.yml`:

```yaml
name: Leash review
on:
  pull_request:
    paths: [leash.config]
    types: [opened, synchronize, reopened, labeled, unlabeled]
  pull_request_review:
    types: [submitted, dismissed]
permissions:
  contents: read
  pull-requests: write
jobs:
  leash:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: michelelandini36-beep/leash/action@main
        with:
          owners: your-github-username   # who can approve a looser leash
```

Then make **Leash review** a required check in your branch protection, so a looser leash can't merge without you. Without `owners`, approval is the `leash-approved` label instead.

## Dry run and live

Leash starts in **dry-run**: jobs are simulated (open → assigned → funded → paid → released), nothing is paid, and dry-run spending is kept apart from live budgets.

To pay for real, give the agent a wallet on Robinhood Chain with some USDG and a little ETH for gas, then:

```sh
export LEASH_MODE=live
export LEASH_AGENT_PRIVATE_KEY=0x...     # the agent wallet
```

No extra install: the network client ships inside the plugin. It only ever funds the mainnet LeashEscrow pinned in the plugin, [`0x62ed93d484724aD30D1Db63C78F6F2a9131ae876`](https://robinhoodchain.blockscout.com/address/0x62ed93d484724aD30D1Db63C78F6F2a9131ae876) (source verified on [Sourcify](https://repo.sourcify.dev/4663/0x62ed93d484724aD30D1Db63C78F6F2a9131ae876)); if the network's API ever points elsewhere, it refuses.

What happens on a `leash_pay` that your rules allow:

1. The job goes on the Leash job board with the amount, the app and a hint of the recipient (`@l…d`). Never the full details.
2. A runner who pays on that app accepts and **signs the exact terms** (amount, fee, deadline).
3. The plugin checks the signature and fee itself, **seals the recipient's details** to that runner only, approves exactly what the job costs and **funds the escrow**.
4. The runner pays from their own app, seals a proof to you (and to the arbiter) and marks the job paid on-chain.
5. After 24 h the escrow pays the runner. The runner fronted the money, so once the recipient confirms, use `leash_release` to pay them now; use `leash_dispute` within 24 h if nothing arrived.

If no runner pays on that app yet, `leash_pay` says so at once and nothing is posted. If no runner takes the job within 30 minutes, it's withdrawn. If a runner doesn't mark it paid by the deadline, anyone can expire it and you get everything back.

**Fees:** the runner's fee (capped by your `max_fee_bps`, 5% when unset, never above 5%) and a 1% platform fee, only on payments that go through. **Limits:** $20 minimum per job (so it's worth a runner's time); $1,000 per job and $5,000 per agent per day, in the contract, forever.

**Runners:** the runner desk at [leashcash.com/runner](https://leashcash.com/runner/). **Disputes:** decided by the job's arbiter on the sealed proof; if the arbiter doesn't act in 30 days, the agent is refunded.

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

Leash is not a bank. Runners are independent people paying from their own accounts. The escrow contract has been tested and reviewed but not audited by a third party: see [Risks](/docs/risks/). Nothing here is financial advice.
