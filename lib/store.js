/**
 * Backup store. SQLite metadata + content-addressed blobs on disk.
 *
 * Each snapshot row holds the agent_did, name, content_type, SHA-256
 * digest, byte size, created_at, and an optional metadata JSON blob.
 * Blob bytes live in BLOB_DIR named by their SHA-256 digest, which
 * gives natural deduplication and lets the integrity check be a
 * second hash of the file.
 *
 * Storage cost is computed nightly: for each agent_did, sum the live
 * byte-seconds since the last computation, divide by (1024^3 * 86400 * 30)
 * to get GB-months, multiply by $0.01.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.BACKUP_DB_PATH || '/tmp/backup.db';
const BLOB_DIR = process.env.BACKUP_BLOB_DIR || '/tmp/backup_blobs';
const MAX_OBJECT_BYTES = Number(process.env.BACKUP_MAX_OBJECT_BYTES) || 10 * 1024 * 1024;
const PRICE_PER_GB_MONTH_USD = Number(process.env.BACKUP_PRICE_PER_GB_MONTH_USD) || 0.01;

try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch {}
try { mkdirSync(BLOB_DIR, { recursive: true }); } catch {}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    agent_did TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS snapshots_agent_idx ON snapshots(agent_did, created_at);
  CREATE INDEX IF NOT EXISTS snapshots_created_idx ON snapshots(created_at);

  CREATE TABLE IF NOT EXISTS storage_costs (
    day TEXT NOT NULL,
    agent_did TEXT NOT NULL,
    gb_months REAL NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    snapshots INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (day, agent_did)
  );

  CREATE TABLE IF NOT EXISTS daily (
    day TEXT PRIMARY KEY,
    creates INTEGER NOT NULL DEFAULT 0,
    restores INTEGER NOT NULL DEFAULT 0,
    bytes_in INTEGER NOT NULL DEFAULT 0,
    bytes_out INTEGER NOT NULL DEFAULT 0,
    revenue_storage_usd REAL NOT NULL DEFAULT 0,
    revenue_restore_usd REAL NOT NULL DEFAULT 0
  );
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO snapshots (id, agent_did, name, content_type, sha256, size_bytes, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getById: db.prepare('SELECT * FROM snapshots WHERE id = ? AND deleted_at IS NULL'),
  list: db.prepare(`
    SELECT id, agent_did, name, content_type, sha256, size_bytes, created_at, metadata
    FROM snapshots
    WHERE deleted_at IS NULL
      AND (? IS NULL OR agent_did = ?)
      AND (? IS NULL OR created_at >= ?)
      AND (? IS NULL OR created_at <= ?)
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `),
  countLive: db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM snapshots WHERE deleted_at IS NULL
  `),
  liveByAgent: db.prepare(`
    SELECT agent_did, COUNT(*) AS snapshots, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM snapshots WHERE deleted_at IS NULL
    GROUP BY agent_did
  `),
  upsertCost: db.prepare(`
    INSERT INTO storage_costs (day, agent_did, gb_months, cost_usd, snapshots, bytes, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, agent_did) DO UPDATE SET
      gb_months = excluded.gb_months,
      cost_usd = excluded.cost_usd,
      snapshots = excluded.snapshots,
      bytes = excluded.bytes,
      computed_at = excluded.computed_at
  `),
  costsForDay: db.prepare(`
    SELECT day, agent_did, gb_months, cost_usd, snapshots, bytes
    FROM storage_costs WHERE day = ?
    ORDER BY cost_usd DESC
  `),
  dailyUpsert: db.prepare(`
    INSERT INTO daily (day, creates, restores, bytes_in, bytes_out, revenue_storage_usd, revenue_restore_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      creates = creates + excluded.creates,
      restores = restores + excluded.restores,
      bytes_in = bytes_in + excluded.bytes_in,
      bytes_out = bytes_out + excluded.bytes_out,
      revenue_storage_usd = revenue_storage_usd + excluded.revenue_storage_usd,
      revenue_restore_usd = revenue_restore_usd + excluded.revenue_restore_usd
  `),
  dailyRead: db.prepare('SELECT * FROM daily WHERE day = ?'),
};

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function blobPath(sha256) {
  return join(BLOB_DIR, sha256);
}

export function maxObjectBytes() {
  return MAX_OBJECT_BYTES;
}

export function pricePerGbMonth() {
  return PRICE_PER_GB_MONTH_USD;
}

/**
 * Persist a buffer as a snapshot. Returns the row.
 */
export function create({ agent_did, name, content_type, body, metadata }) {
  if (!Buffer.isBuffer(body)) return { ok: false, error: 'body_must_be_buffer' };
  if (body.length === 0) return { ok: false, error: 'empty_body' };
  if (body.length > MAX_OBJECT_BYTES) return { ok: false, error: 'object_too_large', limit: MAX_OBJECT_BYTES };

  const sha256 = createHash('sha256').update(body).digest('hex');
  const path = blobPath(sha256);
  if (!existsSync(path)) {
    writeFileSync(path, body);
  }
  const id = `bk_${randomUUID().replace(/-/g, '')}`;
  const created_at = Math.floor(Date.now() / 1000);
  const metaJson = metadata ? JSON.stringify(metadata) : null;
  stmts.insert.run(id, agent_did, name, content_type || 'application/octet-stream', sha256, body.length, created_at, metaJson);
  stmts.dailyUpsert.run(dayKey(), 1, 0, body.length, 0, 0, 0);
  return {
    ok: true,
    id,
    agent_did,
    name,
    content_type: content_type || 'application/octet-stream',
    sha256,
    size_bytes: body.length,
    created_at,
    metadata: metadata || null,
  };
}

export function getById(id) {
  const row = stmts.getById.get(id);
  if (!row) return { ok: false, error: 'not_found' };
  const path = blobPath(row.sha256);
  if (!existsSync(path)) return { ok: false, error: 'blob_missing', sha256: row.sha256 };
  const buf = readFileSync(path);
  const verify = createHash('sha256').update(buf).digest('hex');
  if (verify !== row.sha256) return { ok: false, error: 'integrity_check_failed', expected: row.sha256, actual: verify };
  return {
    ok: true,
    id: row.id,
    agent_did: row.agent_did,
    name: row.name,
    content_type: row.content_type,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    body: buf,
  };
}

export function list({ agent_did, since, until, limit, offset } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const rows = stmts.list.all(
    agent_did || null, agent_did || null,
    since == null ? null : Number(since), since == null ? null : Number(since),
    until == null ? null : Number(until), until == null ? null : Number(until),
    lim, off,
  );
  return rows.map(r => ({
    id: r.id,
    agent_did: r.agent_did,
    name: r.name,
    content_type: r.content_type,
    sha256: r.sha256,
    size_bytes: r.size_bytes,
    created_at: r.created_at,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  }));
}

export function recordRestore({ size_bytes, revenue_usd }) {
  stmts.dailyUpsert.run(dayKey(), 0, 1, 0, size_bytes || 0, 0, revenue_usd || 0);
}

export function recordStorageRevenue(usd) {
  stmts.dailyUpsert.run(dayKey(), 0, 0, 0, 0, usd || 0, 0);
}

/**
 * Compute storage cost for the most recent 24h window.
 *   gb_months = bytes * (86400 / (1024^3 * 86400 * 30))
 *             = bytes / (1024^3 * 30)
 * Idempotent on (day, agent_did).
 */
export function computeStorageCosts() {
  const day = dayKey();
  const computed_at = Math.floor(Date.now() / 1000);
  const rows = stmts.liveByAgent.all();
  const denom = (1024 ** 3) * 30;
  let total_usd = 0;
  for (const r of rows) {
    const gb_months = r.bytes / denom;
    const cost_usd = gb_months * PRICE_PER_GB_MONTH_USD;
    stmts.upsertCost.run(day, r.agent_did, gb_months, cost_usd, r.snapshots, r.bytes, computed_at);
    total_usd += cost_usd;
  }
  if (total_usd > 0) recordStorageRevenue(total_usd);
  return { day, agents: rows.length, total_usd };
}

export function todayCosts() {
  const day = dayKey();
  return stmts.costsForDay.all(day);
}

export function todayMetrics() {
  const day = dayKey();
  const row = stmts.dailyRead.get(day) || {
    day, creates: 0, restores: 0, bytes_in: 0, bytes_out: 0,
    revenue_storage_usd: 0, revenue_restore_usd: 0,
  };
  return {
    ...row,
    revenue_total_usd: (row.revenue_storage_usd || 0) + (row.revenue_restore_usd || 0),
  };
}

export function stats() {
  const c = stmts.countLive.get();
  return {
    snapshots: c.n,
    bytes_stored: c.bytes,
    blob_dir: BLOB_DIR,
    db_path: DB_PATH,
    max_object_bytes: MAX_OBJECT_BYTES,
  };
}

/**
 * Verify integrity of a snapshot without returning the body.
 */
export function verify(id) {
  const row = stmts.getById.get(id);
  if (!row) return { ok: false, error: 'not_found' };
  const path = blobPath(row.sha256);
  if (!existsSync(path)) return { ok: false, error: 'blob_missing' };
  const st = statSync(path);
  if (st.size !== row.size_bytes) return { ok: false, error: 'size_mismatch', expected: row.size_bytes, actual: st.size };
  const buf = readFileSync(path);
  const verify = createHash('sha256').update(buf).digest('hex');
  if (verify !== row.sha256) return { ok: false, error: 'integrity_check_failed', expected: row.sha256, actual: verify };
  return { ok: true, id, sha256: row.sha256, size_bytes: row.size_bytes };
}
