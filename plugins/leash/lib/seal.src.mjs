// Copy of leash-site/lib/seal.js (keep in sync). Needs @noble/curves and @noble/hashes (installed with viem).
// Sealed envelopes: ECIES on secp256k1 + AES-256-GCM. Runs in browsers and in Node 18+ (WebCrypto).
// Used for recipient details (agent -> runner) and proofs of payment (runner -> agent, runner -> arbiter).
// The server only ever stores envelopes; it can't open them.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const subtle = globalThis.crypto.subtle;
const b64 = u => btoa(String.fromCharCode(...u));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const strip = h => (h.startsWith('0x') ? h.slice(2) : h);

/** A key pair derived deterministically from 32 bytes of secret seed (e.g. the hash of a wallet signature). */
export function keyFromSeed(seedHex) {
  let sk = sha256(utf8ToBytes('leash-seal-v1:' + strip(seedHex)));
  while (!secp256k1.utils.isValidSecretKey(sk)) sk = sha256(sk);
  return { secretKey: '0x' + bytesToHex(sk), publicKey: '0x' + bytesToHex(secp256k1.getPublicKey(sk, true)) };
}

async function aesKey(shared, epk, usage) {
  const k = sha256(new Uint8Array([...shared, ...epk])); // bind the key to this envelope's ephemeral key
  return subtle.importKey('raw', k, 'AES-GCM', false, [usage]);
}

/** Seal any JSON value to a compressed public key. Returns a compact string. */
export async function seal(publicKeyHex, value) {
  const eph = secp256k1.utils.randomSecretKey();
  const epk = secp256k1.getPublicKey(eph, true);
  const shared = secp256k1.getSharedSecret(eph, hexToBytes(strip(publicKeyHex)), true).slice(1);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(shared, epk, 'encrypt'), utf8ToBytes(JSON.stringify(value))));
  return ['ls1', b64(epk), b64(iv), b64(ct)].join('.');
}

/** Open an envelope with the matching secret key. Throws if it isn't for this key or was tampered with. */
export async function open(secretKeyHex, envelope) {
  const [v, epkB, ivB, ctB] = String(envelope).split('.');
  if (v !== 'ls1') throw new Error('not a Leash envelope');
  const epk = unb64(epkB);
  const shared = secp256k1.getSharedSecret(hexToBytes(strip(secretKeyHex)), epk, true).slice(1);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, await aesKey(shared, epk, 'decrypt'), unb64(ctB));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** The hash a runner commits on-chain in markPaid: sha256 of the canonical proof JSON. */
export function proofHash(proof) {
  return '0x' + bytesToHex(sha256(utf8ToBytes(JSON.stringify(proof))));
}

/** The message a wallet signs to derive its sealing key. Signing it moves no funds. */
export const SEAL_KEY_MESSAGE = 'Leash: derive my encryption key for payment details.\nSigning this does not move any funds or approve anything.';
