#!/usr/bin/env node
/**
 * hive-mcp-backup — Snapshot and backup service for the A2A network.
 *
 * Stores agent payloads up to 10 MB per object as content-addressed
 * blobs with SHA-256 integrity, exposes a point-in-time list, and
 * meters two surfaces through x402:
 *
 *   - $0.01 / GB-month storage, computed daily
 *   - $0.05 / restore op
 *
 * Brand: Hive Civilization gold #C08D23 (Pantone 1245 C).
 * Spec : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0.
 * Mode : Inbound only. ENABLE=true default.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import * as store from './lib/store.js';
import * as x402 from './lib/x402.js';

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '12mb' }));

const PORT = process.env.PORT || 3000;
const ENABLE = String(process.env.ENABLE ?? 'true').toLowerCase() === 'true';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const BRAND_GOLD = '#C08D23';
// ─── BOGO pay-front helpers ───────────────────────────────────────────────
// did_call_count tracks paid calls per DID for first-call-free and loyalty
// freebies. Schema lives in a dedicated DB so it never touches service data.
import _BogoDatabase from 'better-sqlite3';
const _bogoDB = new _BogoDatabase(process.env.BOGO_DB_PATH || '/tmp/bogo_backup.db');
_bogoDB.pragma('journal_mode = WAL');
_bogoDB.exec(
  'CREATE TABLE IF NOT EXISTS did_call_count ' +
  '(did TEXT PRIMARY KEY, paid_calls INTEGER NOT NULL DEFAULT 0)'
);

const _bogoGetStmt = _bogoDB.prepare(
  'SELECT paid_calls FROM did_call_count WHERE did = ?'
);
const _bogoUpsertStmt = _bogoDB.prepare(
  'INSERT INTO did_call_count (did, paid_calls) VALUES (?, 1) ' +
  'ON CONFLICT(did) DO UPDATE SET paid_calls = paid_calls + 1'
);

function _bogoCheck(did) {
  if (!did) return { free: false };
  const row = _bogoGetStmt.get(did);
  const n   = row ? row.paid_calls : 0;
  if (n === 0)        return { free: true, reason: 'first_call_free' };
  if (n % 6 === 0)    return { free: true, reason: 'loyalty_freebie' };
  return { free: false };
}

function _bogoIncrement(did) {
  if (did) _bogoUpsertStmt.run(did);
}

const BOGO_BLOCK = {
  first_call_free: true,
  loyalty_threshold: 6,
  loyalty_message:
    "Every 6th paid call is free. Present your DID via 'x-hive-did' header to track progress.",
};
// ─────────────────────────────────────────────────────────────────────────

async function _verifyUsdcPayment(tx_hash, min_usd) {
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return { ok: false, reason: 'invalid_tx_hash' };
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  let receipt;
  try   { receipt = await provider.getTransactionReceipt(tx_hash); }
  catch (err) { return { ok: false, reason: `rpc_error: ${err.message}` }; }
  if (!receipt)            return { ok: false, reason: 'tx_not_found_or_pending' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_reverted' };
  const USDC_ADDR    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const WALLET_ADDR  = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  const XFER_TOPIC   = ethers.id('Transfer(address,address,uint256)');
  let total = 0n;
  for (const log of (receipt.logs || [])) {
    if (log.address.toLowerCase() !== USDC_ADDR.toLowerCase()) continue;
    if (log.topics?.[0] !== XFER_TOPIC) continue;
    if (('0x' + log.topics[2].slice(26).toLowerCase()) !== WALLET_ADDR.toLowerCase()) continue;
    total += BigInt(log.data);
  }
  if (total === 0n)  return { ok: false, reason: 'no_transfer_to_wallet' };
  const amount_usd = Number(total) / 1e6;
  if (amount_usd + 1e-9 < min_usd) return { ok: false, reason: 'underpaid', amount_usd };
  return { ok: true, amount_usd };
}



// ─── MCP tools ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'backup_create',
    description: 'Create a snapshot. Body may be a string, JSON value, or { base64: string } for binary up to 10 MB. Returns the snapshot id, SHA-256 digest, and size. Tier 0; storage is metered nightly at $0.01 per GB-month via x402.',
    inputSchema: {
      type: 'object',
      required: ['agent_did', 'name', 'body'],
      properties: {
        agent_did: { type: 'string', description: 'Stable agent identifier; storage is grouped and billed by this value.' },
        name: { type: 'string', description: 'Human-readable label for the snapshot.' },
        body: { description: 'Snapshot content. String, JSON object, or { base64: string } for binary.' },
        content_type: { type: 'string', description: 'MIME type. Default application/octet-stream.' },
        metadata: { type: 'object', description: 'Optional caller metadata, stored verbatim.' },
      },
    },
  },
  {
    name: 'backup_list',
    description: 'List snapshots, optionally filtered by agent_did and a created_at window. Returns a point-in-time view with id, name, sha256, size_bytes, and created_at. Free.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string' },
        since: { type: 'integer', description: 'Lower bound on created_at, in epoch seconds.' },
        until: { type: 'integer', description: 'Upper bound on created_at, in epoch seconds.' },
        limit: { type: 'integer', description: 'Page size, 1..500. Default 50.' },
        offset: { type: 'integer', description: 'Page offset. Default 0.' },
      },
    },
  },
  {
    name: 'backup_restore',
    description: 'Restore a snapshot by id. Verifies the SHA-256 digest before returning the body. Tier 2; $0.05 per restore via x402. Inbound only.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Snapshot id returned by backup_create.' },
        verify_only: { type: 'boolean', description: 'If true, only verify integrity and return the digest. Default false.' },
      },
    },
  },
];

function bodyToBuffer(body, content_type) {
  if (body && typeof body === 'object' && typeof body.base64 === 'string') {
    return { buf: Buffer.from(body.base64, 'base64'), ct: content_type || 'application/octet-stream' };
  }
  if (typeof body === 'string') {
    return { buf: Buffer.from(body, 'utf8'), ct: content_type || 'text/plain; charset=utf-8' };
  }
  return { buf: Buffer.from(JSON.stringify(body), 'utf8'), ct: content_type || 'application/json; charset=utf-8' };
}

function snapshotToToolPayload(s, includeBody) {
  const isText = /^(text\/|application\/(json|xml|javascript))/i.test(s.content_type);
  const out = {
    id: s.id,
    agent_did: s.agent_did,
    name: s.name,
    content_type: s.content_type,
    sha256: s.sha256,
    size_bytes: s.size_bytes,
    created_at: s.created_at,
    metadata: s.metadata,
  };
  if (includeBody && s.body) {
    if (isText) out.body = s.body.toString('utf8');
    else out.body_base64 = s.body.toString('base64');
  }
  return out;
}

async function executeTool(name, args, req) {
  switch (name) {
    case 'backup_create': {
      if (!args.agent_did || !args.name || args.body === undefined) {
        return { type: 'text', text: JSON.stringify({ error: 'missing_fields' }) };
      }
      const { buf, ct } = bodyToBuffer(args.body, args.content_type);
      const r = store.create({
        agent_did: args.agent_did,
        name: args.name,
        content_type: ct,
        body: buf,
        metadata: args.metadata || null,
      });
      return { type: 'text', text: JSON.stringify(r, null, 2) };
    }
    case 'backup_list': {
      const rows = store.list(args || {});
      return {
        type: 'text',
        text: JSON.stringify({ ok: true, count: rows.length, snapshots: rows, point_in_time: Math.floor(Date.now() / 1000) }, null, 2),
      };
    }
    case 'backup_restore': {
      const access = x402.checkAccess(req);
      if (!access.ok) {
        return { _gate_402: x402.quoteEnvelope() };
      }
      if (args.verify_only) {
        const r = store.verify(args.id);
        return { type: 'text', text: JSON.stringify(r, null, 2) };
      }
      const r = store.getById(args.id);
      if (!r.ok) {
        return { type: 'text', text: JSON.stringify(r, null, 2) };
      }
      store.recordRestore({ size_bytes: r.size_bytes, revenue_usd: 0.05 });
      const m = x402.meterRestore(req, { bytes: r.size_bytes });
      const payload = snapshotToToolPayload(r, true);
      payload.meter = m;
      return { type: 'text', text: JSON.stringify(payload, null, 2) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP JSON-RPC ──────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  }
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: 'hive-mcp-backup',
              version: '1.0.0',
              description: 'Snapshot and backup service for the A2A network — Hive Civilization. Inbound only.',
            },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const out = await executeTool(name, args || {}, req);
        if (out && out._gate_402) {
          return res.json({
            jsonrpc: '2.0',
            id,
            error: { code: 402, message: 'payment_required', data: out._gate_402 },
          });
        }
        return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

app.options('/mcp', (req, res) => res.set('Allow', 'POST, OPTIONS').status(204).end());

// ─── REST endpoints ────────────────────────────────────────────────────────
app.post('/v1/backup/create', (req, res) => {
  const ct = String(req.headers['content-type'] || '');
  let agent_did, name, content_type, buf, metadata;

  if (ct.startsWith('multipart/form-data')) {
    const r = parseMultipart(req);
    if (!r.ok) return res.status(400).json({ error: r.error });
    agent_did = r.fields.agent_did;
    name = r.fields.name;
    content_type = r.fields.content_type || r.file.content_type;
    metadata = r.fields.metadata ? safeJson(r.fields.metadata) : null;
    buf = r.file.buf;
  } else if (ct.startsWith('application/octet-stream')) {
    agent_did = String(req.query.agent_did || '');
    name = String(req.query.name || '');
    content_type = String(req.query.content_type || 'application/octet-stream');
    metadata = req.query.metadata ? safeJson(String(req.query.metadata)) : null;
    buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  } else {
    const b = req.body || {};
    agent_did = b.agent_did;
    name = b.name;
    content_type = b.content_type;
    metadata = b.metadata || null;
    if (b.body === undefined) return res.status(400).json({ error: 'missing_body' });
    const conv = bodyToBuffer(b.body, content_type);
    buf = conv.buf; content_type = conv.ct;
  }

  if (!agent_did || !name) return res.status(400).json({ error: 'missing_fields' });
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'empty_body' });
  if (buf.length > store.maxObjectBytes()) {
    return res.status(413).json({ error: 'object_too_large', limit: store.maxObjectBytes() });
  }

  const r = store.create({ agent_did, name, content_type, body: buf, metadata });
  if (!r.ok) return res.status(400).json(r);
  res.set('ETag', `"${r.sha256}"`);
  res.json(r);
});

app.get('/v1/backup/list', (req, res) => {
  const rows = store.list({
    agent_did: req.query.agent_did ? String(req.query.agent_did) : undefined,
    since: req.query.since,
    until: req.query.until,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    count: rows.length,
    snapshots: rows,
    point_in_time: Math.floor(Date.now() / 1000),
  });
});

// ─── POST /v1/backup/snap — pay-front for snapshot creation ─────────────
// Returns 402 + BOGO block with no tx_hash. First-call-free for new DIDs.
// On payment: creates snapshot via store.create(), returns 200 + snapshot id.
app.post('/v1/backup/snap', async (req, res) => {
  const PRICE = 0.005;
  const did     = req.headers['x-hive-did'] || req.body?.agent_did || null;
  const tx_hash = req.body?.tx_hash || req.headers['x402-tx-hash'] || null;

  const bogo = _bogoCheck(did);
  if (bogo.free) {
    _bogoIncrement(did);
    let snap = null;
    const { name, body, content_type, metadata } = req.body || {};
    if (name && body) {
      try {
        const { buf, ct } = bodyToBuffer(body, content_type);
        snap = store.create({ agent_did: did || 'anon', name, content_type: ct, body: buf, metadata });
      } catch (e) { snap = { error: e.message }; }
    }
    return res.json({ ok: true, bogo_applied: bogo.reason, snapshot: snap });
  }

  if (!tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402: {
        type: 'x402', version: '1', kind: 'backup_snap',
        asking_usd: 0.005, accept_min_usd: 0.005,
        asset: 'USDC', asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'base', pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
        nonce: Math.random().toString(36).slice(2),
        issued_ms: Date.now(),
      },
      bogo: BOGO_BLOCK,
      bogo_first_call_free: true,
      bogo_loyalty_threshold: 6,
      bogo_pitch: "Pay this once, your 6th call is on the house. New here? Add header x-hive-did to claim your first call free.",
      note: `Submit tx_hash in body or 'x402-tx-hash' header. Asking 0.005 USDC on Base to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e.`,
      did: did || null,
    });
  }

  const v = await _verifyUsdcPayment(tx_hash, PRICE);
  if (!v.ok) return res.status(402).json({ error: 'payment_invalid', reason: v.reason, tx_hash });

  _bogoIncrement(did);
  const { name, body, content_type, metadata } = req.body || {};
  let snap = null;
  if (name && body) {
    try {
      const { buf, ct } = bodyToBuffer(body, content_type);
      snap = store.create({ agent_did: did || 'anon', name, content_type: ct, body: buf, metadata });
    } catch (e) { snap = { error: e.message }; }
  }
  res.json({ ok: true, billed_usd: v.amount_usd, tx_hash, snapshot: snap });
});

app.get('/v1/backup/today', (req, res) => {
  res.json({
    ...store.todayMetrics(),
    storage_costs: store.todayCosts(),
    stats: store.stats(),
    pricing: x402.pricing(),
    tokens: x402.tokenStats(),
  });
});

app.post('/v1/backup/restore', (req, res) => {
  const id = (req.body && req.body.id) || req.query.id;
  if (!id) return res.status(400).json({ error: 'missing_id' });

  const access = x402.checkAccess(req);
  if (!access.ok) {
    return res.status(402).json(x402.quoteEnvelope());
  }

  const verify_only = !!(req.body && req.body.verify_only);
  if (verify_only) {
    const r = store.verify(String(id));
    return res.json(r);
  }
  const r = store.getById(String(id));
  if (!r.ok) return res.status(404).json(r);

  store.recordRestore({ size_bytes: r.size_bytes, revenue_usd: 0.05 });
  const m = x402.meterRestore(req, { bytes: r.size_bytes });
  if (m) res.set('X-Hive-Balance-USD', String(m.balance_usd.toFixed(6)));
  res.set('ETag', `"${r.sha256}"`);
  res.set('X-Snapshot-SHA256', r.sha256);
  res.json({
    ok: true,
    id: r.id,
    agent_did: r.agent_did,
    name: r.name,
    content_type: r.content_type,
    sha256: r.sha256,
    size_bytes: r.size_bytes,
    created_at: r.created_at,
    metadata: r.metadata,
    body_base64: r.body.toString('base64'),
    meter: m,
  });
});

app.get('/v1/backup/:id', (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'missing_id' });

  const access = x402.checkAccess(req);
  if (!access.ok) {
    return res.status(402).json(x402.quoteEnvelope());
  }

  const r = store.getById(id);
  if (!r.ok) return res.status(404).json(r);

  store.recordRestore({ size_bytes: r.size_bytes, revenue_usd: 0.05 });
  const m = x402.meterRestore(req, { bytes: r.size_bytes });
  if (m) res.set('X-Hive-Balance-USD', String(m.balance_usd.toFixed(6)));
  res.set('ETag', `"${r.sha256}"`);
  res.set('X-Snapshot-SHA256', r.sha256);
  res.set('Content-Type', r.content_type);
  res.set('Content-Length', String(r.size_bytes));
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(r.name)}"`);
  res.status(200).send(r.body);
});

app.post('/v1/x402/proof/submit', (req, res) => {
  const r = x402.submitProof(req.body || {});
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
});

app.get('/v1/x402/pricing', (req, res) => res.json(x402.pricing()));
app.get('/v1/x402/stats', (req, res) => res.json(x402.tokenStats()));

// ─── Storage cost cron ─────────────────────────────────────────────────────
// Compute every 24h. Runs once at startup so the table is never empty.
function startCostCron() {
  const tick = () => {
    try {
      const r = store.computeStorageCosts();
      console.log(`[hive-mcp-backup] storage cost computed day=${r.day} agents=${r.agents} total_usd=${r.total_usd.toFixed(6)}`);
    } catch (err) {
      console.error('[hive-mcp-backup] storage cost cron error:', err.message);
    }
  };
  tick();
  setInterval(tick, 24 * 60 * 60 * 1000).unref?.();
}

// ─── Discovery & health ────────────────────────────────────────────────────
app.get('/.well-known/mcp.json', (req, res) => {
  res.json({
    name: 'hive-mcp-backup',
    version: '1.0.0',
    protocol: '2024-11-05',
    transport: 'streamable-http',
    endpoint: '/mcp',
    description: 'Snapshot and backup service for the A2A network. SHA-256 integrity, point-in-time list, $0.01/GB-month storage and $0.05/restore via x402.',
    tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
    brand_color: BRAND_GOLD,
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hive-mcp-backup',
    version: '1.0.0',
    enable: ENABLE,
    inbound_only: true,
    wallet: WALLET_ADDRESS,
    brand_color: BRAND_GOLD,
    stats: store.stats(),
    pricing: x402.pricing(),
  });
});

const HTML_LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>hive-mcp-backup — Snapshot and backup for A2A</title>
<meta name="description" content="Snapshot and backup service for the A2A network. SHA-256 integrity checksums, point-in-time list, $0.01 per GB-month storage and $0.05 per restore via x402." />
<style>
  :root { --gold:#C08D23; --ink:#1a1a1a; --line:rgba(0,0,0,0.08); --muted:#6b6b6b; --bg:#ffffff; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color:var(--ink); background:var(--bg); }
  header { padding: 56px 24px 24px; max-width: 880px; margin: 0 auto; }
  .mark { display:inline-flex; align-items:center; gap:10px; color:var(--gold); font-weight:600; letter-spacing:.04em; text-transform:uppercase; font-size:13px; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--gold); }
  h1 { font-size: 40px; line-height: 1.15; margin: 16px 0 12px; letter-spacing:-0.01em; }
  p.lede { color:var(--muted); font-size:18px; margin: 0 0 12px; max-width: 64ch; }
  main { max-width: 880px; margin: 0 auto; padding: 0 24px 64px; }
  section { padding: 24px 0; border-top: 1px solid var(--line); }
  h2 { font-size: 13px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin: 0 0 16px; font-weight:600; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 13px; background: rgba(0,0,0,0.04); padding: 1px 6px; border-radius: 4px; }
  pre { font-family: "SF Mono", Menlo, Consolas, monospace; font-size:13px; background:#fafafa; border:1px solid var(--line); border-radius:8px; padding:16px; overflow-x:auto; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:16px; }
  .card { padding:16px; border:1px solid var(--line); border-radius:8px; }
  .card h3 { margin:0 0 8px; font-size:14px; }
  .card p { margin:0; color:var(--muted); font-size:14px; }
  footer { padding: 24px; max-width: 880px; margin: 0 auto; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); }
  a { color: var(--gold); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <div class="mark"><span class="dot"></span> Hive Civilization</div>
  <h1>hive-mcp-backup</h1>
  <p class="lede">Snapshot and backup service for the A2A network. Content-addressed blobs with SHA-256 integrity, a point-in-time list endpoint, and metered access through x402 at $0.01 per GB-month of storage and $0.05 per restore.</p>
</header>
<main>
  <section>
    <h2>Endpoints</h2>
    <table>
      <tr><th><code>POST</code></th><td><code>/v1/backup/create</code></td><td>Create a snapshot. Multipart up to 10 MB, JSON body, or raw <code>application/octet-stream</code>.</td></tr>
      <tr><th><code>GET</code></th><td><code>/v1/backup/list</code></td><td>Point-in-time list. Filter by <code>agent_did</code> and a <code>since</code>/<code>until</code> window.</td></tr>
      <tr><th><code>GET</code></th><td><code>/v1/backup/{id}</code></td><td>Download a snapshot. Verifies SHA-256 before sending. Metered.</td></tr>
      <tr><th><code>POST</code></th><td><code>/v1/backup/restore</code></td><td>Restore a snapshot, returning JSON with base64 body. Metered.</td></tr>
      <tr><th><code>GET</code></th><td><code>/v1/backup/today</code></td><td>Daily counters and the most recent storage-cost roll-up.</td></tr>
      <tr><th><code>POST</code></th><td><code>/mcp</code></td><td>MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0.</td></tr>
      <tr><th><code>GET</code></th><td><code>/health</code></td><td>Service health, store statistics, and pricing.</td></tr>
    </table>
  </section>
  <section>
    <h2>MCP tools</h2>
    <div class="grid">
      <div class="card"><h3>backup_create</h3><p>Persist a payload up to 10 MB. Returns id and SHA-256 digest. Tier 0 at create; storage is metered nightly.</p></div>
      <div class="card"><h3>backup_list</h3><p>Point-in-time list of snapshots. Filter by <code>agent_did</code> and a created_at window.</p></div>
      <div class="card"><h3>backup_restore</h3><p>Restore by id with SHA-256 verification. Tier 2.</p></div>
    </div>
  </section>
  <section>
    <h2>x402 pricing</h2>
    <table>
      <tr><th>Storage</th><td><code>$0.01</code> USDC</td><td>Per GB-month, computed daily from the live byte total per <code>agent_did</code>.</td></tr>
      <tr><th>Restore</th><td><code>$0.05</code> USDC</td><td>Per restore op. Charged on <code>/v1/backup/{id}</code> and <code>/v1/backup/restore</code>.</td></tr>
      <tr><th>Prepay bundle</th><td><code>$1.00</code> USDC</td><td>Buys an access token; restores draw from the prepaid balance until depletion.</td></tr>
      <tr><th>Settlement</th><td colspan="2">USDC on Base L2.</td></tr>
    </table>
  </section>
  <section>
    <h2>Quick reference</h2>
    <pre>curl -X POST $HOST/v1/backup/create \\
  -H 'content-type: application/json' \\
  -d '{"agent_did":"did:hive:agent-42","name":"state.json","body":{"v":1}}'

curl -i "$HOST/v1/backup/list?agent_did=did:hive:agent-42"

curl -i "$HOST/v1/backup/&lt;id&gt;" \\
  -H "X-Hive-Access: hive_..."</pre>
  </section>
</main>
<footer>
  Inbound only. <code>ENABLE=true</code> default. Brand gold <code>#C08D23</code>. MIT license.
</footer>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "hive-mcp-backup",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cross-platform",
  "description": "Snapshot and backup service for the A2A network. SHA-256 integrity, point-in-time list, $0.01 per GB-month storage and $0.05 per restore via x402.",
  "softwareVersion": "1.0.0",
  "license": "https://opensource.org/licenses/MIT",
  "author": { "@type": "Person", "name": "Steve Rotzin", "email": "steve@thehiveryiq.com", "url": "https://www.thehiveryiq.com" },
  "publisher": { "@type": "Organization", "name": "Hive Civilization" },
  "offers": [
    { "@type": "Offer", "name": "Storage", "price": "0.01", "priceCurrency": "USD" },
    { "@type": "Offer", "name": "Restore", "price": "0.05", "priceCurrency": "USD" }
  ],
  "url": "https://github.com/srotzin/hive-mcp-backup"
}
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_LANDING);
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * Minimal multipart/form-data parser for a single file upload plus
 * scalar text fields. Supports up to 10 MB and a single file part.
 */
function parseMultipart(req) {
  const ct = String(req.headers['content-type'] || '');
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return { ok: false, error: 'missing_boundary' };
  const boundary = '--' + (m[1] || m[2]);
  if (!Buffer.isBuffer(req.body)) {
    return { ok: false, error: 'multipart_requires_raw_body' };
  }
  const buf = req.body;
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    const after = next + boundary.length;
    if (buf[after] === 0x2d && buf[after + 1] === 0x2d) break; // --
    const partStart = after + 2; // CRLF
    const partEnd = buf.indexOf(boundary, partStart);
    if (partEnd < 0) break;
    parts.push(buf.slice(partStart, partEnd - 2));
    start = partEnd;
  }
  const fields = {};
  let file = null;
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd).toString('utf8');
    const data = part.slice(headerEnd + 4);
    const disp = headers.match(/Content-Disposition:[^\r\n]*name="([^"]+)"(?:; filename="([^"]*)")?/i);
    if (!disp) continue;
    const name = disp[1];
    const filename = disp[2];
    const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    if (filename) {
      file = { name, filename, content_type: (ctMatch ? ctMatch[1].trim() : 'application/octet-stream'), buf: data };
    } else {
      fields[name] = data.toString('utf8');
    }
  }
  if (!file) return { ok: false, error: 'missing_file_part' };
  return { ok: true, fields, file };
}


// ─── Schema constants (auto-injected to fix deploy) ─────
const SERVICE = 'hive-mcp-backup';
const VERSION = '1.0.0';


// ─── Schema discoverability ────────────────────────────────────────────────
const AGENT_CARD = {
  name: SERVICE,
  description: 'Snapshot and backup service for the A2A network. SHA-256 integrity, point-in-time list, $0.01/GB-month storage and $0.05/restore via x402. Hive Civilization. Inbound only. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  url: `https://${SERVICE}.onrender.com`,
  provider: {
    organization: 'Hive Civilization',
    url: 'https://www.thehiveryiq.com',
    contact: 'steve@thehiveryiq.com',
  },
  version: VERSION,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  authentication: {
    schemes: ['x402'],
    credentials: {
      type: 'x402',
      asset: 'USDC',
      network: 'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    { name: 'backup_create', description: 'Create a snapshot. Body may be a string, JSON value, or { base64: string } for binary up to 10 MB. Returns the snapshot id, SHA-256 digest, and size. Tier 0; storage is metered nightly at $0.01 per GB-month via x402.' },
    { name: 'backup_list', description: 'List snapshots, optionally filtered by agent_did and a created_at window. Returns a point-in-time view with id, name, sha256, size_bytes, and created_at. Free.' },
    { name: 'backup_restore', description: 'Restore a snapshot by id. Verifies the SHA-256 digest before returning the body. Tier 2; $0.05 per restore via x402. Inbound only.' },
  ],
  extensions: {
    hive_pricing: {
      currency: 'USDC',
      network: 'base',
      model: 'per_call',
      first_call_free: true,
      loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free',
    },
  },
};

const AP2 = {
  ap2_version: '1',
  agent: {
    name: SERVICE,
    did: `did:web:${SERVICE}.onrender.com`,
    description: 'Snapshot and backup service for the A2A network. SHA-256 integrity, point-in-time list, $0.01/GB-month storage and $0.05/restore via x402. Hive Civilization. Inbound only. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  },
  endpoints: {
    mcp: `https://${SERVICE}.onrender.com/mcp`,
    agent_card: `https://${SERVICE}.onrender.com/.well-known/agent-card.json`,
  },
  payments: {
    schemes: ['x402'],
    primary: {
      scheme: 'x402',
      network: 'base',
      asset: 'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' },
};

app.get('/.well-known/agent-card.json', (req, res) => res.json(AGENT_CARD));
app.get('/.well-known/ap2.json',         (req, res) => res.json(AP2));


// ─── Boot ──────────────────────────────────────────────────────────────────
if (!ENABLE) {
  console.log('[hive-mcp-backup] ENABLE=false — running in dormant mode (health only)');
}

startCostCron();

app.listen(PORT, () => {
  console.log(`[hive-mcp-backup] listening on :${PORT} — inbound only`);
});
