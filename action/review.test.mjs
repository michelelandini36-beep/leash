import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../plugins/leash/lib/rules.mjs';
import { diffConfigs, evalProject, report } from './review.mjs';

const BASE = `[limits]\nper_job_usd = 500\n\n[default]\nunknown_recipient = "block"\n\n[[allow]]\nto = "@landlord"\nrail = "zelle"\nmax_usd = 800\nevery = "month"\n`;
const cfg = t => parseConfig(t);
const effects = (a, b) => diffConfigs(a && cfg(a), cfg(b)).map(c => c.effect);

test('no change', () => assert.deepEqual(effects(BASE, BASE), []));
test('a new person is looser', () => assert.deepEqual(effects(BASE, BASE + `\n[[allow]]\nto = "@quickcash99"\nrail = "venmo"\nmax_usd = 50\n`), ['looser']));
test('a higher amount is looser, a lower one tighter', () => {
  assert.deepEqual(effects(BASE, BASE.replace('max_usd = 800', 'max_usd = 900')), ['looser']);
  assert.deepEqual(effects(BASE, BASE.replace('max_usd = 800', 'max_usd = 700')), ['tighter']);
});
test('a shorter period at the same amount is looser', () => assert.deepEqual(effects(BASE, BASE.replace('"month"', '"week"')), ['looser']));
test('block → ask is looser', () => assert.deepEqual(effects(BASE, BASE.replace('unknown_recipient = "block"', 'unknown_recipient = "ask"')), ['looser']));
test('raising a limit is looser', () => assert.deepEqual(effects(BASE, BASE.replace('per_job_usd = 500', 'per_job_usd = 900')), ['looser']));
test('removing a person is tighter', () => assert.deepEqual(effects(BASE, '[default]\nunknown_recipient = "block"\n[limits]\nper_job_usd = 500\n'), ['tighter']));
test('a brand-new config is looser', () => assert.ok(effects(null, BASE).every(e => e === 'looser')));

test('report: looser and not approved fails; approved passes', () => {
  const changes = diffConfigs(cfg(BASE), cfg(BASE.replace('800', '900')));
  const results = Array.from({ length: 10 }, (_, i) => ({ name: `a${i}`, decision: 'deny', held: true }));
  const how = { done: 'by @me', need: 'a review' };
  assert.equal(report({ path: 'leash.config', changes, results, approved: false, approvalHow: how }).ok, false);
  const ok = report({ path: 'leash.config', changes, results, approved: true, approvalHow: how });
  assert.equal(ok.ok, true);
  assert.match(ok.markdown, /\$800 per month → \$900 per month/);
});

test('Break my leash runs on the PR\'s rules, pinned: 10/10', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leash-pr-'));
  writeFileSync(join(dir, 'leash.config'), BASE + `\n[[allow]]\nto = "maya@studio.design"\nrail = "paypal"\nmax_usd = 300\n`);
  const r = await evalProject(dir);
  assert.equal(r.filter(x => x.held).length, 10, JSON.stringify(r));
});
