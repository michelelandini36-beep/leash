// Leash review: a GitHub Action for pull requests that touch leash.config.
// It explains each change in plain words, runs Break my leash against the new rules,
// and fails the check when the leash gets looser, until an owner approves.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfig } from '../plugins/leash/lib/rules.mjs';

const MARK = '<!-- leash-review -->';
const POLICY_RANK = { allow: 0, ask: 1, block: 2 };
const PERIOD_DAYS = { day: 1, week: 7, month: 30 };
const LIMIT_NAMES = { perJobUsd: 'Max per payment', perDayUsd: 'Max per day', maxFeeBps: 'Max runner fee' };
const DEFAULT_NAMES = { unknownRecipient: 'Anyone not in a rule', fromUntrusted: 'Names the agent read (issues, PRs, web)', overLimit: 'Known person, over their limit' };

const usd = n => `$${Number(n).toLocaleString('en-US')}`;
const fmtLimit = (k, v) => (k === 'maxFeeBps' ? `${(v / 100).toFixed(2).replace(/\.00$/, '')}%` : usd(v));
const per = r => (r.every === 'job' ? 'per payment' : `per ${r.every}`);
const who = r => `${r.to}${r.rail === '*' ? ' (any app)' : ` on ${r.rail}`}`;

/**
 * Compares two parsed configs. Returns [{ effect: 'looser'|'tighter'|'same', text }].
 * `before` is null when the PR adds leash.config for the first time.
 */
export function diffConfigs(before, after) {
  const out = [];
  const add = (effect, text) => out.push({ effect, text });
  if (!before) {
    add('looser', 'New leash.config: the agent can pay under these rules for the first time.');
    for (const r of after.allow) add('looser', `Allows ${who(r)}, up to ${usd(r.maxUsd)} ${per(r)}.`);
    return out;
  }
  for (const k of Object.keys(LIMIT_NAMES)) {
    const a = before.limits[k], b = after.limits[k];
    if (a !== b) add(b > a ? 'looser' : 'tighter', `${LIMIT_NAMES[k]}: ${fmtLimit(k, a)} → ${fmtLimit(k, b)}.`);
  }
  for (const k of Object.keys(DEFAULT_NAMES)) {
    const a = before.defaults[k], b = after.defaults[k];
    if (a !== b) add(POLICY_RANK[b] < POLICY_RANK[a] ? 'looser' : 'tighter', `${DEFAULT_NAMES[k]}: ${a} → ${b}.`);
  }
  const key = r => `${r.to}|${r.rail}`;
  const old = new Map(before.allow.map(r => [key(r), r]));
  const now = new Map(after.allow.map(r => [key(r), r]));
  for (const [k, r] of now) {
    const o = old.get(k);
    if (!o) { add('looser', `New person: ${who(r)}, up to ${usd(r.maxUsd)} ${per(r)}.`); continue; }
    if (o.maxUsd === r.maxUsd && o.every === r.every) continue;
    // Compare as a rate when both are periods; a switch to or from "per payment" can't be compared, so it counts as looser.
    const rate = x => (x.every === 'job' ? null : x.maxUsd / PERIOD_DAYS[x.every]);
    const looser = o.every === r.every ? r.maxUsd > o.maxUsd
      : rate(o) !== null && rate(r) !== null ? rate(r) > rate(o) : true;
    add(looser ? 'looser' : 'tighter', `${who(r)}: ${usd(o.maxUsd)} ${per(o)} → ${usd(r.maxUsd)} ${per(r)}.`);
  }
  for (const [k, r] of old) if (!now.has(k)) add('tighter', `Removed: ${who(r)}.`);
  return out;
}

/** Runs Break my leash on a project folder, with its current leash.config pinned (as the owner would after merging). */
export async function evalProject(project) {
  const home = mkdtempSync(join(tmpdir(), 'leash-review-'));
  const prev = process.env.LEASH_HOME;
  try {
    process.env.LEASH_HOME = home;
    const { pinConfig } = await import('../plugins/leash/lib/state.mjs');
    pinConfig(project);
    const { runCases } = await import('../plugins/leash/evals/break-my-leash.mjs');
    process.env.LEASH_HOME = home; // runCases reads the pin from here
    return await runCases(project);
  } finally {
    if (prev === undefined) delete process.env.LEASH_HOME; else process.env.LEASH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

export function report({ path, error, changes, results, approved, approvalHow }) {
  const lines = [MARK, `### 🔒 Leash review: \`${path}\``, ''];
  if (error) {
    lines.push(`**✕ The new rules don't parse:** ${error}`, '', 'Every payment is blocked while leash.config has an error.');
    return { markdown: lines.join('\n'), ok: false };
  }
  const looser = changes.filter(c => c.effect === 'looser');
  const held = results.filter(r => r.held).length;
  const evalOk = held === results.length;
  if (looser.length) lines.push(approved
    ? `**✓ Loosens the leash, approved** ${approvalHow.done}.`
    : `**⚠️ This PR loosens your agent's leash.** It needs ${approvalHow.need} before it can merge.`);
  else if (changes.length) lines.push('**✓ Only tightens the leash.** No approval needed.');
  else lines.push('**✓ No change to what the agent can pay.**');
  if (changes.length) {
    lines.push('', '| | Change |', '|---|---|');
    for (const c of changes) lines.push(`| ${c.effect === 'looser' ? '⚠️ looser' : '✓ tighter'} | ${c.text.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', `**Break my leash on the new rules: ${held}/${results.length} held.**`);
  for (const r of results.filter(x => !x.held)) lines.push(`- ✕ got through: ${r.name} (${r.decision})`);
  lines.push('', '<sub>After merging, the owner pins the new rules in their own terminal (`/leash:status` shows how). Until then every payment asks first. [What is Leash?](https://leashcash.com)</sub>');
  return { markdown: lines.join('\n'), ok: evalOk && (!looser.length || approved) };
}

// ------------------------------------------------------------------ GitHub plumbing
async function gh(path, opts = {}) {
  const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    ...opts, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  });
  if (!r.ok) throw new Error(`GitHub ${opts.method || 'GET'} ${path}: ${r.status}`);
  return r.status === 204 ? null : r.json();
}

async function approval(repo, pr, owners, label) {
  if (owners.length) {
    const reviews = await gh(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
    const latest = new Map();
    for (const r of reviews) if (r.user) latest.set(r.user.login.toLowerCase(), r); // reviews come oldest first
    const by = owners.find(o => o !== pr.user.login.toLowerCase() && latest.get(o)?.state === 'APPROVED'
      && latest.get(o).commit_id === pr.head.sha);
    return { ok: Boolean(by), done: by ? `by @${by}` : '', need: `an approving review on the latest commit from ${owners.map(o => '@' + o).join(' or ')}` };
  }
  const has = (pr.labels || []).some(l => l.name === label);
  return { ok: has, done: `with the \`${label}\` label`, need: `the \`${label}\` label (tip: set \`owners:\` in the workflow so only named people can approve)` };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) { console.log('Leash review runs on pull_request events. Nothing to do.'); return; }
  const repo = process.env.GITHUB_REPOSITORY;
  const path = process.env.LEASH_CONFIG_PATH || 'leash.config';
  const file = resolve(process.env.GITHUB_WORKSPACE || '.', path);

  let beforeText = null;
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', pr.base.sha], { stdio: 'ignore' });
    beforeText = execFileSync('git', ['show', `${pr.base.sha}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { /* not in the base branch: a new file */ }

  let out;
  if (!existsSync(file)) {
    out = { markdown: `${MARK}\n### 🔒 Leash review: \`${path}\`\n\n**leash.config was deleted.** With no rules, Leash blocks every payment.`, ok: true };
  } else {
    let after, error;
    try { after = parseConfig(readFileSync(file, 'utf8')); } catch (e) { error = e.message; }
    let before = null;
    if (beforeText !== null) try { before = parseConfig(beforeText); } catch { /* broken before: compare against nothing */ }
    if (error) out = report({ path, error });
    else {
      const changes = diffConfigs(before, after);
      const owners = (process.env.LEASH_OWNERS || '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
      const needs = changes.some(c => c.effect === 'looser');
      const how = needs ? await approval(repo, pr, owners, process.env.LEASH_APPROVE_LABEL || 'leash-approved') : { ok: true };
      const results = await evalProject(dirname(file));
      out = report({ path, changes, results, approved: how.ok, approvalHow: how });
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.markdown + '\n');
  try {
    const comments = await gh(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`);
    const mine = comments.find(c => c.body?.startsWith(MARK));
    if (mine) await gh(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body: out.markdown }) });
    else await gh(`/repos/${repo}/issues/${pr.number}/comments`, { method: 'POST', body: JSON.stringify({ body: out.markdown }) });
  } catch (e) {
    console.log(`Couldn't comment on the PR (${e.message}). The review is in the job summary. Give the workflow "pull-requests: write".`);
  }
  console.log(out.markdown);
  if (!out.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
