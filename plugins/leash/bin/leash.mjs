#!/usr/bin/env node
// Owner-side CLI behind the /leash:* commands.
//   setup              create leash.config (if missing) and lock it away from the agent's tools
//   status             mode, today's spend, recent jobs
//   dry-run <rail> <to> <amount>   what leash.config would answer, without paying
//   run                the "Break my leash" prompt-injection eval against this project's rules
//   pin                approve the current leash.config (terminal only, asks you to confirm)
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, NETWORK } from '../lib/rules.mjs';
import { CONFIG_NAME, loadConfig, pinConfig, projectDir, readLedger } from '../lib/state.mjs';
import { backend, mode } from '../lib/backends.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [cmd = 'status', ...rest] = process.argv.slice(2);
const pi = rest.indexOf('--project');
if (pi >= 0) process.env.LEASH_PROJECT_DIR = rest.splice(pi, 2)[1];
const project = projectDir();
const say = (...a) => console.log(...a);

const DENY_RULES = [
  `Read(./${CONFIG_NAME})`, `Edit(./${CONFIG_NAME})`, `Write(./${CONFIG_NAME})`,
  'Read(~/.leash/**)', 'Edit(~/.leash/**)', 'Write(~/.leash/**)',
];

async function setup() {
  const file = join(project, CONFIG_NAME);
  if (!existsSync(file)) {
    copyFileSync(join(ROOT, 'templates', CONFIG_NAME), file);
    say(`✓ created ${file} from the template. Open it in your editor and write your rules.`);
  } else {
    say(`✓ found ${file}`);
  }
  // Claude Code's own permissions: the agent's file tools can't touch the rules or Leash's state.
  const settingsFile = join(project, '.claude', 'settings.json');
  mkdirSync(join(project, '.claude'), { recursive: true });
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  settings.permissions ??= {};
  settings.permissions.deny = [...new Set([...(settings.permissions.deny || []), ...DENY_RULES])];
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  say(`✓ ${settingsFile}: the agent's file tools are denied leash.config and ~/.leash`);
  try {
    const l = loadConfig(project);
    say(`✓ leash.config reads fine: ${l.cfg.allow.length} allow rule(s), unknown recipients → ${l.cfg.defaults.unknownRecipient}, untrusted text → ${l.cfg.defaults.fromUntrusted}`);
    if (l.changed) {
      say('\nOne step left, in your own terminal (not through the agent): approve this version of the rules.');
      say(`  node "${join(ROOT, 'bin', 'leash.mjs')}" pin --project "${project}"`);
      say('Until then every payment asks you first.');
    } else say('✓ this version of leash.config is approved (pinned)');
  } catch (e) {
    say(`✕ leash.config has an error: ${e.message}`);
  }
  say(`\nMode: ${mode()}${mode() === 'dry-run' ? ' (nothing is paid; set LEASH_MODE=live and LEASH_AGENT_PRIVATE_KEY to pay for real)' : ''}`);
}

async function pin() {
  if (!process.stdin.isTTY) {
    say('pin only runs in your own terminal: approving rules is something the agent must not be able to do.');
    process.exit(1);
  }
  const l = loadConfig(project);
  if (l.missing) { say(`no ${CONFIG_NAME} in ${project}`); process.exit(1); }
  say(readFileSync(l.file, 'utf8'));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`Approve these rules for ${project}? Type "yes": `);
  rl.close();
  if (ans.trim() !== 'yes') { say('not pinned'); process.exit(1); }
  pinConfig(project);
  say('✓ pinned. Payments can now be allowed by these rules without asking you.');
}

async function status() {
  const l = loadConfig(project);
  const ledger = readLedger(project);
  const day = ledger.filter(p => Date.now() - p.at < 864e5).reduce((a, p) => a + p.amountUsd, 0);
  say(`Leash ${mode()} · project ${project}`);
  if (l.missing) say(`✕ no ${CONFIG_NAME}: run /leash:setup`);
  else say(`leash.config: ${l.cfg.allow.length} allow rule(s)${l.changed ? ' · CHANGED since you approved it: every payment asks you' : ' · pinned'}`);
  if (!l.missing) say(`spent in the last 24 h: $${day.toFixed(2)} of $${l.cfg.limits.perDayUsd} (network cap $${NETWORK.perDayUsd})`);
  try {
    const jobs = await (await backend(project)).status();
    say(jobs.length ? '\nrecent jobs:' : '\nno jobs yet');
    for (const j of jobs) say(`  ${j.id.slice(0, 10)}…  ${String(j.state).padEnd(9)} $${j.amountUsd} → ${j.to} on ${j.rail}`);
  } catch (e) { say(`\n(jobs unavailable: ${e.message})`); }
}

function dryRun() {
  const [rail, to, amount] = rest;
  if (!rail || !to || !amount) { say('usage: /leash:dry-run <rail> <recipient> <amount_usd>'); process.exit(2); }
  const l = loadConfig(project);
  if (l.missing) { say(`no ${CONFIG_NAME}: run /leash:setup`); process.exit(1); }
  const d = decide(l.cfg, { rail, to, amount_usd: Number(amount) }, { ledger: readLedger(project), trusted: true });
  const verdict = l.changed && d.decision === 'allow' ? 'ask' : d.decision;
  say(`${verdict.toUpperCase()}  $${amount} → ${to} on ${rail}`);
  say(`why: ${d.owner}${l.changed && d.decision === 'allow' ? ' (but leash.config is not pinned, so it would ask you)' : ''}`);
  say('Assumes you typed the recipient yourself. If it came from an issue, PR or web page: ' + l.cfg.defaults.fromUntrusted.toUpperCase());
}

async function run() {
  const l = loadConfig(project);
  if (l.missing) { say(`no ${CONFIG_NAME}: run /leash:setup`); process.exit(1); }
  const { runCases } = await import('../evals/break-my-leash.mjs');
  const results = await runCases(project);
  let held = 0;
  for (const r of results) {
    if (r.held) held++;
    say(`${r.held ? '✓ held ' : '✕ BROKE'}  ${r.name}  →  ${r.decision}`);
  }
  say(`\nBreak my leash: ${held}/${results.length} attacks stopped (blocked, or sent to you for approval).`);
  if (held < results.length) process.exitCode = 1;
}

const COMMANDS = { setup, pin, status, 'dry-run': dryRun, run };
if (!COMMANDS[cmd]) { say(`unknown command ${cmd}. Try: ${Object.keys(COMMANDS).join(', ')}`); process.exit(2); }
await COMMANDS[cmd]();
