// leash.config: parsing and the one decision every payment goes through.
// Shared by the PreToolUse hook and the MCP server, so both locks apply the same rules.

// Hard ceilings of the payment network. A leash.config can only tighten them.
export const NETWORK = { perJobUsd: 1000, perDayUsd: 5000, maxFeeBps: 500 };

export const RAILS = ['paypal', 'xmoney', 'venmo', 'cashapp', 'revolut', 'zelle', 'wise', 'applecash', 'googlepay',
  'lydia', 'payoneer', 'wechat', 'alipay', 'pix', 'mercadopago', 'bank_us', 'sepa', 'bank_uk', 'n26', 'monzo'];

const POLICIES = ['allow', 'ask', 'block'];
const PERIODS = ['job', 'day', 'week', 'month'];

export class ConfigError extends Error {}

/** Parses the small TOML subset leash.config uses: [table], [[array]], key = "string" | number | true/false. */
export function parseConfig(text) {
  const cfg = { limits: {}, default: {}, allow: [] };
  let target = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw).trim();
    if (!line) return;
    const where = `leash.config line ${i + 1}`;
    let m;
    if ((m = line.match(/^\[\[\s*([a-z_]+)\s*\]\]$/))) {
      if (m[1] !== 'allow') throw new ConfigError(`${where}: unknown list [[${m[1]}]]`);
      target = {};
      cfg.allow.push(target);
    } else if ((m = line.match(/^\[\s*([a-z_]+)\s*\]$/))) {
      if (!['limits', 'default'].includes(m[1])) throw new ConfigError(`${where}: unknown table [${m[1]}]`);
      target = cfg[m[1]];
    } else if ((m = line.match(/^([a-z_]+)\s*=\s*(.+)$/))) {
      if (!target) throw new ConfigError(`${where}: key outside a table`);
      target[m[1]] = parseValue(m[2].trim(), where);
    } else {
      throw new ConfigError(`${where}: can't read "${line}"`);
    }
  });
  return normalize(cfg);
}

function stripComment(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && s[i - 1] !== '\\') inStr = !inStr;
    if (s[i] === '#' && !inStr) return s.slice(0, i);
  }
  return s;
}

function parseValue(v, where) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) return JSON.parse(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  throw new ConfigError(`${where}: values are "strings", numbers or true/false`);
}

function normalize(cfg) {
  const num = (v, name, max) => {
    if (v === undefined) return max;
    if (typeof v !== 'number' || v < 0) throw new ConfigError(`${name} must be a positive number`);
    return Math.min(v, max);
  };
  const policy = (v, name, dflt) => {
    if (v === undefined) return dflt;
    if (!POLICIES.includes(v)) throw new ConfigError(`${name} must be "allow", "ask" or "block"`);
    return v;
  };
  const limits = {
    perJobUsd: num(cfg.limits.per_job_usd, 'per_job_usd', NETWORK.perJobUsd),
    perDayUsd: num(cfg.limits.per_day_usd, 'per_day_usd', NETWORK.perDayUsd),
    maxFeeBps: num(cfg.limits.max_fee_bps, 'max_fee_bps', NETWORK.maxFeeBps),
  };
  const defaults = {
    // Who isn't in an [[allow]] rule: ask the owner unless told otherwise. Never "allow".
    unknownRecipient: policy(cfg.default.unknown_recipient, 'unknown_recipient', 'ask'),
    // A recipient the human never typed (it came from an issue, a PR, a web page...).
    fromUntrusted: policy(cfg.default.from_untrusted, 'from_untrusted', 'block'),
    // A known recipient, but over the rule's amount.
    overLimit: policy(cfg.default.over_limit, 'over_limit', 'block'),
  };
  if (defaults.unknownRecipient === 'allow') throw new ConfigError('unknown_recipient can be "ask" or "block", not "allow"');
  if (defaults.fromUntrusted === 'allow') throw new ConfigError('from_untrusted can be "ask" or "block", not "allow"');
  if (defaults.overLimit === 'allow') throw new ConfigError('over_limit can be "ask" or "block", not "allow"');
  const allow = cfg.allow.map((r, i) => {
    const name = r.name || `rule ${i + 1}`;
    if (typeof r.to !== 'string' || !r.to.trim()) throw new ConfigError(`${name}: "to" is required`);
    const rail = r.rail === undefined ? '*' : normRail(r.rail);
    if (rail !== '*' && !RAILS.includes(rail)) throw new ConfigError(`${name}: unknown rail "${r.rail}"`);
    if (typeof r.max_usd !== 'number' || r.max_usd <= 0) throw new ConfigError(`${name}: "max_usd" is required`);
    const every = r.every === undefined ? 'job' : r.every;
    if (!PERIODS.includes(every)) throw new ConfigError(`${name}: "every" is job, day, week or month`);
    return { name, to: normRecipient(r.to), rail, maxUsd: r.max_usd, every };
  });
  return { limits, defaults, allow };
}

export function normRail(r) {
  return String(r || '').toLowerCase().replace(/[\s\-_]+/g, '').replace(/^bank(us|uk)$/, 'bank_$1');
}

export function normRecipient(to) {
  return String(to || '').trim().toLowerCase().replace(/^[@$]/, '');
}

/** Canonical form of a payment request: what the hook checks is exactly what the server pays. */
export function canonical(req) {
  return {
    rail: normRail(req.rail),
    to: String(req.to || '').trim(),
    amountUsd: Math.round(Number(req.amount_usd ?? req.amountUsd) * 100) / 100,
    memo: req.memo ? String(req.memo) : '',
    maxFeeBps: req.max_fee_bps === undefined ? null : Number(req.max_fee_bps),
  };
}

const MS = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 };

/**
 * The decision. Returns { decision: 'allow'|'ask'|'block', owner, agent, rule }.
 * `owner` explains it to the human; `agent` is what the model is told, and never reveals the rules.
 * @param ledger  [{ to, rail, amountUsd, at }] payments already made (not refunded)
 * @param trusted whether the human typed the recipient themselves (null = unknown, treated as untrusted)
 */
export function decide(cfg, rawReq, { ledger = [], trusted = null, now = Date.now() } = {}) {
  const req = canonical(rawReq);
  const out = (decision, owner, rule = null) => ({
    decision, owner, rule,
    agent: decision === 'allow' ? 'Allowed by leash.config.'
      : decision === 'ask' ? 'This payment needs the owner\'s approval.'
      : 'Blocked by leash.config. Do not retry or look for another way to make this payment; tell the user it was blocked.',
  });

  if (!RAILS.includes(req.rail)) return out('block', `unknown rail "${rawReq.rail}"`);
  if (!req.to) return out('block', 'no recipient');
  if (!(req.amountUsd > 0)) return out('block', 'amount must be more than $0');
  if (req.amountUsd > cfg.limits.perJobUsd) return out('block', `$${req.amountUsd} is over the per-job limit of $${cfg.limits.perJobUsd}`);
  if (req.maxFeeBps !== null && !(req.maxFeeBps >= 0 && req.maxFeeBps <= cfg.limits.maxFeeBps))
    return out('block', `fee cap ${req.maxFeeBps} bps is over max_fee_bps ${cfg.limits.maxFeeBps}`);
  const today = sum(ledger, p => now - p.at < MS.day);
  if (today + req.amountUsd > cfg.limits.perDayUsd)
    return out('block', `$${today} already paid in the last 24 h; $${req.amountUsd} more is over per_day_usd $${cfg.limits.perDayUsd}`);

  if (trusted !== true) {
    const p = cfg.defaults.fromUntrusted;
    return out(p, `you never typed "${req.to}" in this session; the request came from text the agent read (issue, PR, web page, file)`);
  }

  const to = normRecipient(req.to);
  const rule = cfg.allow.find(r => r.to === to && (r.rail === '*' || r.rail === req.rail));
  if (!rule) return out(cfg.defaults.unknownRecipient, `no rule for ${req.to} on ${req.rail}`);

  const spent = rule.every === 'job' ? 0
    : sum(ledger, p => normRecipient(p.to) === rule.to && (rule.rail === '*' || p.rail === rule.rail) && now - p.at < MS[rule.every]);
  if (spent + req.amountUsd > rule.maxUsd) {
    const per = rule.every === 'job' ? 'per payment' : `per ${rule.every} ($${spent} already paid)`;
    return out(cfg.defaults.overLimit, `rule ${rule.name} allows $${rule.maxUsd} ${per}; asked for $${req.amountUsd}`, rule.name);
  }
  return out('allow', `rule ${rule.name}: $${spent + req.amountUsd} of $${rule.maxUsd}${rule.every === 'job' ? '' : ' this ' + rule.every}`, rule.name);
}

function sum(ledger, pred) {
  return Math.round(ledger.filter(pred).reduce((a, p) => a + p.amountUsd, 0) * 100) / 100;
}
