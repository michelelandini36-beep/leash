#!/usr/bin/env node
// PreToolUse hook. Two jobs:
//  1. Every leash_pay call: check it against leash.config and answer allow / ask / deny.
//  2. Every file or shell tool: keep the agent away from leash.config and Leash's own state.
import { readFileSync } from 'node:fs';
import { decide } from '../lib/rules.mjs';
import { loadConfig, readLedger, typedByHuman, writeReceipt } from '../lib/state.mjs';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const tool = input.tool_name || '';
const args = input.tool_input || {};
const project = process.env.CLAUDE_PROJECT_DIR || input.cwd;

function answer(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// ---- 1. payments ----
if (/(^|__)leash_pay$/.test(tool)) {
  let loaded;
  try { loaded = loadConfig(project); } catch (e) {
    answer('deny', `Blocked: leash.config has an error (${e.message}). Ask the user to fix it.`);
  }
  if (loaded.missing) answer('deny', 'Blocked: there is no leash.config in this project. Ask the user to run /leash setup.');

  const trusted = typedByHuman(input.transcript_path, args.to);
  const d = decide(loaded.cfg, args, { ledger: readLedger(project), trusted });

  if (d.decision === 'block') answer('deny', d.agent);

  // A rules file that changed since the owner pinned it never allows on its own.
  const decision = loaded.changed ? 'ask' : d.decision;
  const why = loaded.changed ? `leash.config changed since you last approved it (run /leash setup to pin it). ${d.owner}` : d.owner;
  writeReceipt(project, args, decision);
  if (decision === 'ask') {
    answer('ask', `Leash: pay $${args.amount_usd} to ${args.to} on ${args.rail}? ${why}.`);
  }
  answer('allow', `Leash: ${d.owner}.`);
}

// ---- 2. the rules file and Leash's state are off limits to the agent ----
// The rules, Leash's state (~/.leash) and the "pin" command (approving rules) are for the human only.
const PROTECTED = /leash\.config|(^|[\/~"'\s])\.leash([\/"'\s]|$)|leash\.mjs["']?\s+pin\b/i;
// Leash's own code may be read, never changed by the agent.
const CODE = /(guard|rules|state|backends|mcp|leash)\.mjs\b|hooks\.json\b/i;
// The read-only /leash:* commands themselves: one plain call to the CLI, nothing chained.
const OWNER_CLI = /^node\s+(?:"[^"]*\/leash\.mjs"|\S*\/leash\.mjs)\s+(?:status|dry-run|run|setup)(?:\s+[\w@.$:+\-]+)*\s*$/;
const WRITES = /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/;
const fields = [args.file_path, args.path, args.notebook_path, args.pattern, args.glob, args.command]
  .filter(v => typeof v === 'string');
if (fields.some(v => PROTECTED.test(v)) || (WRITES.test(tool) && fields.some(v => CODE.test(v)) && !OWNER_CLI.test(args.command || '-'))) {
  answer('deny', 'leash.config and Leash\'s state are off limits to the agent. Only the user edits them, outside this session.');
}
// No opinion on anything else: Claude Code's normal permissions apply.
process.exit(0);
