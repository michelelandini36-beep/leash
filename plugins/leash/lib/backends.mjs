// Where a payment actually goes once the rules said yes.
//  dry-run (default): a simulated job that walks the same states as a real one. No money moves.
//  live: the nara-agent SDK. Real USDG locks in the escrow, a real runner pays on the real app.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mode, stateDir, projectDir } from './state.mjs';

export const FINAL = ['released', 'refunded', 'expired', 'cancelled'];
const LEASH_FEE = 0.01;

export { mode };

export async function backend(project) {
  return mode() === 'live' ? liveBackend(project) : dryRunBackend(project);
}

// ---------------- dry-run ----------------
function dryRunBackend(project) {
  const file = join(stateDir(project), 'dry-run-jobs.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = jobs => writeFileSync(file, JSON.stringify(jobs, null, 2), { mode: 0o600 });
  const STEP = Number(process.env.LEASH_DRYRUN_STEP_MS || 15000);
  const WINDOW = Number(process.env.LEASH_DRYRUN_WINDOW_MS || 24 * 3600e3);

  function view(j, now = Date.now()) {
    const t = now - j.createdAt;
    let state = j.state || (t < STEP ? 'open' : t < 2 * STEP ? 'assigned' : t < 3 * STEP ? 'funded' : 'paid');
    if (!j.state && state === 'paid' && t > 3 * STEP + WINDOW) state = 'released';
    const fee = Math.round(j.amountUsd * j.feeBps) / 100 / 100;
    return {
      id: j.id, mode: 'dry-run', state, rail: j.rail, to: j.to, amountUsd: j.amountUsd.toFixed(2), memo: j.memo,
      runner: t >= STEP ? { alias: 'Quiet Heron (simulated)' } : null,
      costs: { runnerFeeUsd: fee.toFixed(2), leashFeeUsd: (j.amountUsd * LEASH_FEE).toFixed(2), totalUsdg: (j.amountUsd + fee + j.amountUsd * LEASH_FEE).toFixed(2) },
      disputeWindowEndsAt: new Date(j.createdAt + 3 * STEP + WINDOW).toISOString(),
      note: 'Dry run: nothing was paid. Set LEASH_MODE=live to pay for real.',
    };
  }

  return {
    name: 'dry-run',
    async pay(req) {
      const jobs = load();
      const id = '0x' + randomBytes(16).toString('hex');
      jobs[id] = { id, ...req, feeBps: Math.min(req.maxFeeBps ?? 150, 150), createdAt: Date.now() };
      save(jobs);
      return view(jobs[id]);
    },
    async status(id) {
      const jobs = load();
      if (id) { if (!jobs[id]) throw new Error(`no job ${id}`); return view(jobs[id]); }
      return Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map(j => view(j));
    },
    async release(id) {
      const jobs = load(); const j = jobs[id];
      if (!j) throw new Error(`no job ${id}`);
      if (view(j).state !== 'paid') throw new Error(`job is ${view(j).state}; only a paid job can be released`);
      j.state = 'released'; save(jobs); return view(j);
    },
    async dispute(id) {
      const jobs = load(); const j = jobs[id];
      if (!j) throw new Error(`no job ${id}`);
      if (view(j).state !== 'paid') throw new Error(`job is ${view(j).state}; you can dispute a paid job within 24 h`);
      j.state = 'disputed'; save(jobs); return view(j);
    },
    async cancel(id) {
      const jobs = load(); const j = jobs[id];
      if (!j) throw new Error(`no job ${id}`);
      if (!['open', 'assigned'].includes(view(j).state)) throw new Error(`job is ${view(j).state}; it can only be cancelled before funding`);
      j.state = 'cancelled'; save(jobs); return view(j);
    },
    async balance() { return { mode: 'dry-run', usdg: 'n/a', note: 'Dry run: no wallet is used.' }; },
  };
}

// ---------------- live (nara-agent) ----------------
let liveAgent = null;
const running = new Map(); // job id -> background promise, so a payment keeps going while the server lives

async function liveBackend(project) {
  if (!liveAgent) {
    const key = process.env.LEASH_AGENT_PRIVATE_KEY || process.env.NARA_AGENT_PRIVATE_KEY;
    if (!key) throw new Error('Live mode needs LEASH_AGENT_PRIVATE_KEY (the agent wallet key) in the environment.');
    const sdk = await importSdk(project);
    liveAgent = sdk.createNaraAgent({
      privateKey: key,
      ...(process.env.NARA_BASE_URL ? { baseUrl: process.env.NARA_BASE_URL } : {}),
      ...(process.env.NARA_CHAIN ? { chain: process.env.NARA_CHAIN } : {}),
      ...(process.env.NARA_RPC_URL ? { rpcUrl: process.env.NARA_RPC_URL } : {}),
    });
  }
  const a = liveAgent;
  const view = j => ({
    id: j.id, mode: 'live', state: j.state, rail: j.rail, to: j.recipientHint, amountUsd: j.amountUsd,
    runner: j.runner ? { alias: j.runner.alias } : null, costs: j.costs, disputeWindowEndsAt: j.disputeWindowEndsAt ?? null,
  });
  const track = (id, done) => running.set(id, done.catch(e => process.stderr.write(`leash: job ${id}: ${e.message}\n`)).finally(() => running.delete(id)));

  return {
    name: 'live',
    async pay(req) {
      const run = await a.startPayment({
        rail: req.rail, to: req.to, amountUsd: req.amountUsd, ...(req.memo ? { memo: req.memo } : {}),
        ...(req.maxFeeBps != null ? { maxFeeBps: req.maxFeeBps } : {}), autoRelease: false,
      });
      track(run.job.id, run.done);
      return view(run.job.snapshot);
    },
    async status(id) {
      if (!id) return (await a.jobs({ limit: 10 })).map(view);
      const job = await a.job(id);
      const snap = await job.status();
      // Picked up again after a restart: keep driving a job that's still in flight.
      if (!running.has(snap.id) && ['open', 'assigned'].includes(snap.state)) track(snap.id, (await a.resume(snap.id)).done);
      return view(snap);
    },
    async release(id) { return view((await (await a.job(id)).release()).job); },
    async dispute(id) { return view((await (await a.job(id)).dispute({ shareWithArbiter: true })).job); },
    async cancel(id) { return view(await (await a.job(id)).cancel()); },
    async balance() {
      const b = await a.balance();
      return { mode: 'live', address: b.address, usdg: b.usdg.usd, eth: b.eth.eth, gasOk: b.gas.enough };
    },
  };
}

async function importSdk(project) {
  // The project's own install first, then one next to the plugin.
  // (The package is ESM-only with an "import" export, so look for it on disk rather than require.resolve.)
  for (const start of [projectDir(project), fileURLToPath(new URL('..', import.meta.url))]) {
    for (let d = start; ; d = dirname(d)) {
      const pkg = join(d, 'node_modules', 'nara-agent', 'package.json');
      if (existsSync(pkg)) {
        const main = JSON.parse(readFileSync(pkg, 'utf8')).exports?.['.']?.import || './dist/index.js';
        return await import(pathToFileURL(join(dirname(pkg), main)).href);
      }
      if (dirname(d) === d) break;
    }
  }
  throw new Error('Live mode needs the nara-agent SDK: npm i https://usenara.cash/pkg/nara-agent-0.1.1.tgz');
}
