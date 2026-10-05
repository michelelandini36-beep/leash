// Where a payment actually goes once the rules said yes.
//  dry-run (default): a simulated job that walks the same states as a real one. No money moves.
//  live: the Leash network. Real USDG locks in the LeashEscrow contract, a real runner pays on the real app.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { mode, stateDir } from './state.mjs';

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

// ---------------- live (the Leash network) ----------------
// Real USDG locks in the LeashEscrow contract on Robinhood Chain; a Leash runner pays on the real app.
let net = null;
const driving = new Map(); // job id -> promise: posting -> runner accepts -> details sealed -> funded

async function network() {
  if (!net) {
    const { LeashNetwork } = await import('./network.bundle.mjs');
    net = new LeashNetwork({
      privateKey: process.env.LEASH_AGENT_PRIVATE_KEY,
      // The mainnet LeashEscrow, pinned in the plugin: the API can't point the agent's money anywhere else.
      escrow: process.env.LEASH_ESCROW_ADDRESS || '0x62ed93d484724aD30D1Db63C78F6F2a9131ae876',
      apiUrl: process.env.LEASH_NETWORK_URL || 'https://leash-five.vercel.app',
      rpcUrl: process.env.LEASH_RPC_URL,
      log: m => process.stderr.write(`leash: ${m}\n`),
    });
  }
  return net.init();
}

function liveBackend(project) {
  const file = join(stateDir(project), 'live-jobs.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = (id, patch) => { const all = load(); all[id] = { ...all[id], ...patch }; writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 }); };

  function drive(n, entry) {
    if (driving.has(entry.id)) return;
    const p = n.drive(entry, {})
      .then(() => save(entry.id, { funded: true, error: null }))
      .catch(e => save(entry.id, { error: e.message }))
      .finally(() => driving.delete(entry.id));
    driving.set(entry.id, p);
  }

  return {
    name: 'live',
    async pay(req) {
      const n = await network();
      const { job, salt, details } = await n.post_job({ rail: req.rail, to: req.to, amountUsd: req.amountUsd, memo: req.memo, maxFeeBps: req.maxFeeBps ?? 200 });
      const entry = { id: job.id, salt, details, maxFeeBps: req.maxFeeBps ?? 200, createdAt: Date.now() };
      save(job.id, entry);
      drive(n, entry);
      return { id: job.id, mode: 'live', state: 'open', rail: req.rail, amountUsd: req.amountUsd.toFixed(2),
        note: 'Posted to Leash runners. Once one accepts, the USDG locks in the escrow and they pay on the app. Check with leash_status.' };
    },
    async status(id) {
      const n = await network();
      if (!id) return (await n.list()).map(j => ({ id: j.id, state: j.state, rail: j.rail, amountUsd: j.amountUsd, to: j.recipientHint }));
      const local = load()[id];
      const s = await n.status(id);
      // Picked up after a restart: keep driving a job that hasn't been funded yet.
      if (local && !local.funded && ['open', 'assigned'].includes(s.state)) drive(n, local);
      if (local?.error) s.error = local.error;
      return s;
    },
    async release(id) { const n = await network(); return { tx: await n.release(id), ...(await n.status(id)) }; },
    async dispute(id) { const n = await network(); return { tx: await n.dispute(id), ...(await n.status(id)) }; },
    async cancel(id) {
      const n = await network();
      const s = await n.status(id);
      if (['open', 'assigned'].includes(s.state)) { await n.close(id); save(id, { error: 'closed by the agent', funded: true }); return { id, state: 'closed' }; }
      if (s.state === 'funded' && s.payDeadline && Date.parse(s.payDeadline) <= Date.now()) return { tx: await n.expire(id), ...(await n.status(id)) };
      throw new Error(`job is ${s.state}: a funded job refunds by itself if the runner doesn't pay by ${s.payDeadline}, or the runner can cancel it`);
    },
    async balance() { const n = await network(); return { mode: 'live', ...(await n.balance()) }; },
  };
}
