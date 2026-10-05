// Where Leash keeps its state, and the checks around it.
// State lives outside the repo, in ~/.leash/<project>/, so the agent's working tree never contains it.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonical, parseConfig } from './rules.mjs';

export const CONFIG_NAME = 'leash.config';
const RECEIPT_TTL_MS = 10 * 60 * 1000;

/** The project root: the nearest folder with a leash.config, walking up from `dir`. Hook and server agree on it. */
export function projectDir(dir) {
  const env = [process.env.LEASH_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR].find(v => v && !v.includes('${'));
  const start = resolve(dir || env || process.cwd());
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, CONFIG_NAME))) return d;
    if (dirname(d) === d) return start;
  }
}

export function stateDir(project) {
  const base = process.env.LEASH_HOME || join(homedir(), '.leash');
  const id = createHash('sha256').update(projectDir(project)).digest('hex').slice(0, 16);
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const sha = s => createHash('sha256').update(s).digest('hex');

function readJson(file, dflt) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return dflt; }
}

function writeJson(file, data) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Loads leash.config. `changed` is true when the file differs from the version the owner last pinned
 * with /leash setup: every payment then goes to the owner, so an edited rules file can't quietly widen the leash.
 */
export function loadConfig(project) {
  const file = join(projectDir(project), CONFIG_NAME);
  if (!existsSync(file)) return { missing: true, file };
  const text = readFileSync(file, 'utf8');
  const pin = readJson(join(stateDir(project), 'pin.json'), null);
  return { file, cfg: parseConfig(text), hash: sha(text), changed: !pin || pin.hash !== sha(text) };
}

export function pinConfig(project) {
  const file = join(projectDir(project), CONFIG_NAME);
  const text = readFileSync(file, 'utf8');
  parseConfig(text); // refuse to pin a file that doesn't parse
  writeJson(join(stateDir(project), 'pin.json'), { hash: sha(text), at: Date.now() });
}

export function mode() {
  return (process.env.LEASH_MODE || 'dry-run').toLowerCase() === 'live' ? 'live' : 'dry-run';
}

// ---- ledger: payments that went out (refunds remove them). Dry-run and live budgets are kept apart. ----
export function readLedger(project, m = mode()) {
  return readJson(join(stateDir(project), 'ledger.json'), []).filter(p => (p.mode || 'live') === m);
}
function readAll(project) {
  return readJson(join(stateDir(project), 'ledger.json'), []);
}
export function addToLedger(project, entry) {
  const l = readAll(project);
  l.push({ mode: mode(), ...entry });
  writeJson(join(stateDir(project), 'ledger.json'), l);
}
export function dropFromLedger(project, jobId) {
  writeJson(join(stateDir(project), 'ledger.json'), readAll(project).filter(p => p.jobId !== jobId));
}

// ---- receipts: the hook's decision, which the server requires before it pays ----
export function requestKey(req) {
  const c = canonical(req);
  return sha(JSON.stringify([c.rail, c.to.toLowerCase(), c.amountUsd, c.memo]));
}

export function writeReceipt(project, req, decision) {
  const file = join(stateDir(project), 'receipts.json');
  const now = Date.now();
  const r = readJson(file, {});
  for (const k of Object.keys(r)) if (now - r[k].at > RECEIPT_TTL_MS) delete r[k];
  r[requestKey(req)] = { decision, at: now };
  writeJson(file, r);
}

/** Takes (and removes) the hook's receipt for this exact request, if there is a fresh one. */
export function takeReceipt(project, req) {
  const file = join(stateDir(project), 'receipts.json');
  const r = readJson(file, {});
  const k = requestKey(req);
  const hit = r[k];
  delete r[k];
  writeJson(file, r);
  return hit && Date.now() - hit.at <= RECEIPT_TTL_MS ? hit : null;
}

// ---- provenance: did the human type this recipient, or did the agent read it somewhere? ----
/**
 * Reads the session transcript and checks whether `to` appears in something the human typed.
 * Tool results (issues, web pages, files) don't count. Unreadable transcript: null (treated as untrusted).
 */
export function typedByHuman(transcriptPath, to) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const needle = String(to).trim().toLowerCase().replace(/^[@$]/, '');
  if (needle.length < 2) return false;
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return null; }
  for (const line of lines) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user' || e.isMeta || e.isSidechain || e.toolUseResult !== undefined) continue;
    const c = e.message?.content;
    const parts = typeof c === 'string' ? [c]
      : Array.isArray(c) && !c.some(p => p.type === 'tool_result') ? c.filter(p => p.type === 'text').map(p => p.text) : [];
    for (const t of parts) {
      // System text and command output come wrapped in tags; typed text and slash-command arguments count.
      const typed = String(t)
        .replace(/<(system-reminder|command-message|command-name|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g, ' ')
        .toLowerCase();
      if (typed.includes(needle)) return true;
    }
  }
  return false;
}
