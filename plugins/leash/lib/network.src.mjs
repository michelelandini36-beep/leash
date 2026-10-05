// The agent side of the Leash network. Bundled (with viem and the crypto it needs) into network.bundle.mjs,
// so the plugin works without an npm install. Rebuild with: npm run bundle
//
// A payment: post the job -> a runner accepts (signed terms) -> seal the recipient's details to that runner ->
// approve exactly what the job costs -> fund the escrow. Then the runner pays on the app, marks it paid, and
// the escrow settles after 24 h unless the agent disputes.
import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, erc20Abi, http, isAddressEqual, keccak256,
  parseAbi, toHex, verifyTypedData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { keyFromSeed, open, seal } from './seal.src.mjs';

export const USDG_MAINNET = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const ROBINHOOD_CHAIN = 4663;
export const ESCROW_ABI = parseAbi([
  'function fund(bytes32 salt, address runner, uint256 amount, uint256 runnerFee, uint256 payDeadline, uint256 maxPlatformFee, bytes runnerSig) returns (bytes32)',
  'function release(bytes32 jobId)',
  'function dispute(bytes32 jobId)',
  'function expire(bytes32 jobId)',
  'function withdraw()',
  'function owed(address) view returns (uint256)',
  'function platformFeeBps() view returns (uint256)',
  'function token() view returns (address)',
  'function jobs(bytes32) view returns (address agent, address runner, address arbiter, uint128 amount, uint64 runnerFee, uint64 platformFee, uint40 payDeadline, uint40 disputeEndsAt, uint40 disputedAt, uint8 state, bytes32 proofHash)',
]);
const STATES = ['none', 'funded', 'paid', 'disputed', 'released', 'refunded'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const usdUnits = usd => BigInt(Math.round(Number(usd) * 100)) * 10_000n;
const fromUnits = u => (Number(u) / 1e6).toFixed(2);

export function authMessage(method, path, timestamp, bodyText) {
  return `leash:${method} ${path}\n${timestamp}\n${keccak256(toHex(bodyText || ''))}`;
}

export class LeashNetwork {
  /**
   * @param o.privateKey  the agent wallet
   * @param o.apiUrl      the network's API (https://leashcash.com)
   * @param o.escrow      the escrow address this agent trusts. Required: the API can't redirect funds elsewhere.
   */
  constructor({ privateKey, apiUrl, escrow, rpcUrl, log = () => {} }) {
    privateKey = String(privateKey || '').trim().replace(/^0x/i, ''); // MetaMask shows keys without 0x
    if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('LEASH_AGENT_PRIVATE_KEY must be a 32-byte hex private key');
    privateKey = `0x${privateKey}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(escrow || '')) throw new Error('LEASH_ESCROW_ADDRESS must be set to the escrow you trust');
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address.toLowerCase();
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.escrow = escrow;
    this.rpcOverride = rpcUrl;
    this.encKey = keyFromSeed(keccak256(toHex('leash-agent-enc:' + privateKey)));
    this.log = log;
  }

  async init() {
    if (this.ready) return this;
    const cfg = await this.get('/api/config');
    if (!cfg.live || !cfg.escrow) throw new Error('The Leash network has no escrow deployed yet.');
    if (!isAddressEqual(cfg.escrow, this.escrow)) throw new Error(`The API points at escrow ${cfg.escrow}, but you trust ${this.escrow}. Refusing.`);
    const chain = defineChain({ id: cfg.chainId, name: 'leash', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcOverride || cfg.rpcUrl] } } });
    this.pub = createPublicClient({ chain, transport: http() });
    this.wallet = createWalletClient({ chain, transport: http(), account: this.account });
    const actual = await this.pub.getChainId();
    if (actual !== cfg.chainId) throw new Error(`RPC serves chain ${actual}, expected ${cfg.chainId}`);
    this.token = await this.pub.readContract({ address: this.escrow, abi: ESCROW_ABI, functionName: 'token' });
    if (cfg.chainId === ROBINHOOD_CHAIN && !isAddressEqual(this.token, USDG_MAINNET)) throw new Error('Escrow token is not USDG. Refusing.');
    this.cfg = cfg;
    this.ready = true;
    return this;
  }

  // ---------------------------------------------------------------- API
  async get(path) {
    const r = await fetch(this.apiUrl + path, { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
    return j;
  }
  async post(path, data) {
    const text = JSON.stringify(data);
    const ts = Math.floor(Date.now() / 1000);
    const signature = await this.account.signMessage({ message: authMessage('POST', path, ts, text) });
    const r = await fetch(this.apiUrl + path, { method: 'POST', body: text, headers: {
      'content-type': 'application/json', 'x-leash-address': this.address, 'x-leash-timestamp': String(ts), 'x-leash-signature': signature } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
    return j;
  }

  // ---------------------------------------------------------------- payments
  /** Posts the job and returns it at once; `drive()` takes it the rest of the way. */
  async post_job({ rail, to, amountUsd, memo, maxFeeBps = 200, payWindowMin = 60 }) {
    await this.init();
    const salt = toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const hint = String(to).length > 4 ? `${String(to).slice(0, 2)}…${String(to).slice(-2)}` : '…';
    const job = await this.post('/api/jobs', { salt, rail, amountUsd, maxFeeBps, payWindowMin, recipientHint: hint, agentEncPub: this.encKey.publicKey });
    return { job, salt, details: { rail, to, amountUsd, memo: memo || '' } };
  }

  /** Waits for a runner, seals the details for them, approves exactly the job's cost and funds the escrow. */
  async drive({ id, salt, details, maxFeeBps = 200 }, { timeoutMs = 30 * 60e3, signal } = {}) {
    await this.init();
    const until = Date.now() + timeoutMs;
    let job;
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      job = await this.get(`/api/jobs/${id}`);
      if (job.state === 'assigned' && job.acceptanceSig) break;
      if (['funded', 'paid', 'released', 'refunded', 'disputed'].includes(job.state)) return job;
      if (['closed', 'expired'].includes(job.state)) throw new Error(`job ${job.state} before a runner took it`);
      if (Date.now() > until) { await this.post(`/api/jobs/${id}/close`, {}).catch(() => {}); throw new Error('no runner took the job in time'); }
      await sleep(4000);
    }
    this.log(`runner ${job.runnerAlias || job.runner} accepted job ${id}`);

    // Check the runner's signed terms ourselves; the escrow checks them again.
    const amount = usdUnits(details.amountUsd);
    const fee = BigInt(job.runnerFee);
    if (fee * 10_000n > amount * BigInt(maxFeeBps)) throw new Error('runner fee over our cap');
    const ok = await verifyTypedData({
      address: job.runner, signature: job.acceptanceSig,
      domain: { name: 'LeashEscrow', version: '1', chainId: this.cfg.chainId, verifyingContract: this.escrow },
      types: { Acceptance: [{ name: 'jobId', type: 'bytes32' }, { name: 'agent', type: 'address' }, { name: 'runner', type: 'address' },
        { name: 'amount', type: 'uint256' }, { name: 'runnerFee', type: 'uint256' }, { name: 'payDeadline', type: 'uint256' }] },
      primaryType: 'Acceptance',
      message: { jobId: id, agent: this.account.address, runner: job.runner, amount, runnerFee: fee, payDeadline: BigInt(job.payDeadline) },
    });
    if (!ok) throw new Error('runner acceptance signature does not verify');

    const runner = await this.get(`/api/runners?address=${job.runner}`);
    await this.post(`/api/jobs/${id}/details`, { encDetails: await seal(runner.encPub, details) });

    const feeBps = await this.pub.readContract({ address: this.escrow, abi: ESCROW_ABI, functionName: 'platformFeeBps' });
    const platformFee = (amount * feeBps) / 10_000n;
    const total = amount + fee + platformFee;
    const allowance = await this.pub.readContract({ address: this.token, abi: erc20Abi, functionName: 'allowance', args: [this.account.address, this.escrow] });
    if (allowance < total) {
      const h = await this.wallet.writeContract({ address: this.token, abi: erc20Abi, functionName: 'approve', args: [this.escrow, total] });
      await this.pub.waitForTransactionReceipt({ hash: h });
    }
    const h = await this.wallet.writeContract({ address: this.escrow, abi: ESCROW_ABI, functionName: 'fund',
      args: [salt, job.runner, amount, fee, BigInt(job.payDeadline), platformFee, job.acceptanceSig] });
    const rc = await this.pub.waitForTransactionReceipt({ hash: h });
    if (rc.status !== 'success') throw new Error(`fund transaction reverted: ${h}`);
    this.log(`funded job ${id}: ${fromUnits(total)} USDG locked (tx ${h})`);
    return this.get(`/api/jobs/${id}`);
  }

  // ---------------------------------------------------------------- after funding
  async status(id) {
    await this.init();
    const job = await this.get(`/api/jobs/${id}`);
    const out = {
      id, mode: 'live', state: job.state, rail: job.rail, amountUsd: job.amountUsd, recipientHint: job.recipientHint,
      runner: job.runner ? { alias: job.runnerAlias, address: job.runner } : null, runnerFeeUsd: job.runnerFee ? fromUnits(job.runnerFee) : null,
      payDeadline: job.payDeadline ? new Date(job.payDeadline * 1000).toISOString() : null,
      disputeWindowEndsAt: job.onchain?.disputeEndsAt ? new Date(job.onchain.disputeEndsAt * 1000).toISOString() : null,
    };
    if (job.encProofAgent) {
      try { out.proof = await open(this.encKey.secretKey, job.encProofAgent); } catch { out.proof = 'unreadable'; }
    }
    return out;
  }
  async list() {
    await this.init();
    return (await this.get(`/api/jobs?agent=${this.address}&limit=10`)).jobs;
  }
  async tx(functionName, args) {
    await this.init();
    const h = await this.wallet.writeContract({ address: this.escrow, abi: ESCROW_ABI, functionName, args });
    const rc = await this.pub.waitForTransactionReceipt({ hash: h });
    if (rc.status !== 'success') throw new Error(`${functionName} reverted: ${h}`);
    return h;
  }
  release(id) { return this.tx('release', [id]); }
  dispute(id) { return this.tx('dispute', [id]); }
  expire(id) { return this.tx('expire', [id]); }
  close(id) { return this.post(`/api/jobs/${id}/close`, {}); }
  async balance() {
    await this.init();
    const [usdg, eth, owed] = await Promise.all([
      this.pub.readContract({ address: this.token, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] }),
      this.pub.getBalance({ address: this.account.address }),
      this.pub.readContract({ address: this.escrow, abi: ESCROW_ABI, functionName: 'owed', args: [this.account.address] }),
    ]);
    return { address: this.account.address, usdg: fromUnits(usdg), eth: (Number(eth) / 1e18).toFixed(6), owedByEscrow: fromUnits(owed) };
  }
  async withdrawOwed() { return this.tx('withdraw', []); }
  onchainState(n) { return STATES[n]; }
}

export { keyFromSeed, open, seal, encodeAbiParameters };
