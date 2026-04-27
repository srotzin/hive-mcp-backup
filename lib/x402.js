/**
 * x402 micropayment gate for the backup shim.
 *
 * Two metered surfaces:
 *   - storage      : $0.01 / GB-month, computed daily by the cron
 *                    over live snapshots, billed against the storage
 *                    account that holds the prepay token.
 *   - restore      : $0.05 / restore op, charged at /v1/backup/{id}
 *                    GET and at /v1/backup/restore.
 *
 * A payment buys a prepaid balance held against an access token.
 * Restores draw from the balance until depletion. The next call
 * returns a 402 envelope.
 */

import { randomUUID } from 'node:crypto';

const PRICE_PER_RESTORE_USD = Number(process.env.BACKUP_PRICE_PER_RESTORE_USD) || 0.05;
const PRICE_PER_GB_MONTH_USD = Number(process.env.BACKUP_PRICE_PER_GB_MONTH_USD) || 0.01;
const PREPAY_BUNDLE_USD = Number(process.env.BACKUP_PREPAY_BUNDLE_USD) || 1.0;
const RECIPIENT = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const NONCE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;

const nonces = new Map();
const tokens = new Map();

function gc() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires_at < now / 1000) nonces.delete(k);
  for (const [k, v] of tokens) if (v.expires_at < now) tokens.delete(k);
}
setInterval(gc, 60_000).unref?.();

export function quoteEnvelope() {
  const nonce = randomUUID();
  const expires_at = Math.floor((Date.now() + NONCE_TTL_MS) / 1000);
  nonces.set(nonce, { expires_at, paid: false, prepay_usd: PREPAY_BUNDLE_USD });
  return {
    error: 'payment_required',
    payment: {
      nonce,
      amount_usd: PREPAY_BUNDLE_USD,
      pricing: {
        per_restore_usd: PRICE_PER_RESTORE_USD,
        per_gb_month_usd: PRICE_PER_GB_MONTH_USD,
      },
      accepts: [{ chain: 'base', asset: 'USDC', recipient: RECIPIENT }],
      expires_at,
      tier: 2,
      product: 'backup_prepaid_bundle',
    },
  };
}

export function submitProof({ nonce, payer, chain, tx_hash } = {}) {
  if (!nonce || !payer || !chain || !tx_hash) {
    return { ok: false, status: 400, error: 'missing_fields' };
  }
  const n = nonces.get(nonce);
  if (!n) return { ok: false, status: 404, error: 'unknown_or_expired_nonce' };
  if (n.expires_at < Date.now() / 1000) {
    nonces.delete(nonce);
    return { ok: false, status: 410, error: 'nonce_expired' };
  }
  n.paid = true;
  const token = `hive_${randomUUID().replace(/-/g, '')}`;
  tokens.set(token, {
    payer,
    chain,
    tx_hash,
    balance_usd: n.prepay_usd,
    spent_usd: 0,
    restores: 0,
    bytes: 0,
    expires_at: Date.now() + TOKEN_TTL_MS,
  });
  return { ok: true, access_token: token, expires_in: Math.floor(TOKEN_TTL_MS / 1000), balance_usd: n.prepay_usd };
}

function readToken(req) {
  const hdr = req.headers['x-hive-access'];
  if (hdr && tokens.has(hdr)) {
    const t = tokens.get(hdr);
    if (t.expires_at > Date.now()) return { token: hdr, t };
    tokens.delete(hdr);
  }
  return null;
}

export function checkAccess(req) {
  if (process.env.X402_ENABLED && String(process.env.X402_ENABLED).toLowerCase() === 'false') {
    return { ok: true, bypass: 'disabled' };
  }
  const inline = req.headers['x-payment'];
  if (inline) {
    try {
      const env = typeof inline === 'string' ? JSON.parse(inline) : inline;
      if (env?.nonce && env?.payer && env?.chain && env?.tx_hash) {
        const r = submitProof(env);
        if (r.ok) return { ok: true, mint: r };
      }
    } catch { /* fall through */ }
  }
  const t = readToken(req);
  if (t && t.t.balance_usd > 0) return { ok: true, token: t.token };
  return { ok: false };
}

/**
 * Charge the token for a restore operation. Per-restore fee is fixed.
 * Bytes are tracked for accounting. Returns the residual balance for
 * the response header.
 */
export function meterRestore(req, { bytes }) {
  const t = readToken(req);
  if (!t) return null;
  const cost = PRICE_PER_RESTORE_USD;
  t.t.balance_usd = Math.max(0, t.t.balance_usd - cost);
  t.t.spent_usd += cost;
  t.t.restores += 1;
  t.t.bytes += bytes || 0;
  return {
    token: t.token,
    spent_this_request_usd: cost,
    balance_usd: t.t.balance_usd,
    restores: t.t.restores,
    bytes_served: t.t.bytes,
  };
}

export function pricing() {
  return {
    tier: 2,
    product: 'backup',
    per_restore_usd: PRICE_PER_RESTORE_USD,
    per_gb_month_usd: PRICE_PER_GB_MONTH_USD,
    prepay_bundle_usd: PREPAY_BUNDLE_USD,
    chain: 'base',
    asset: 'USDC',
    recipient: RECIPIENT,
    nonce_ttl_seconds: NONCE_TTL_MS / 1000,
    token_ttl_seconds: TOKEN_TTL_MS / 1000,
  };
}

export function tokenStats() {
  return { open_nonces: nonces.size, active_tokens: tokens.size };
}
