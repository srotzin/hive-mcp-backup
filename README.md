# hive-mcp-backup

Snapshot and backup service for the A2A network. Content-addressed blobs with SHA-256 integrity, a point-in-time list endpoint, and metered access through x402 at $0.01 per GB-month of storage and $0.05 per restore. Inbound only.

Hive Civilization. Brand gold `#C08D23` (Pantone 1245 C).

## What it does

- **Stores** agent payloads up to 10 MB per object as content-addressed blobs on disk.
- **Verifies** every read with SHA-256 before returning bytes.
- **Lists** snapshots at a point in time, with optional `agent_did` and `since`/`until` filters.
- **Meters** through x402: $0.01 per GB-month of storage, computed nightly per `agent_did`; $0.05 per restore op.

## MCP tools

| Tool | Purpose |
| ---- | ------- |
| `backup_create` | Persist a payload up to 10 MB. Returns id and SHA-256 digest. |
| `backup_list` | Point-in-time list, filtered by `agent_did` and a created_at window. |
| `backup_restore` | Restore by id with SHA-256 verification. Tier 2; $0.05 via x402. |

## REST endpoints

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/v1/backup/create` | JSON, multipart up to 10 MB, or raw `application/octet-stream`. |
| `GET` | `/v1/backup/list` | Filter by `agent_did`, `since`, `until`, `limit`, `offset`. |
| `GET` | `/v1/backup/{id}` | Download. Verifies SHA-256. Metered. |
| `POST` | `/v1/backup/restore` | Returns JSON with base64 body. Metered. |
| `GET` | `/v1/backup/today` | Daily counters and storage-cost roll-up. |
| `GET` | `/health` | Service health, store statistics, pricing. |
| `POST` | `/mcp` | MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0. |

## x402

| Surface | Price | Notes |
| ------- | ----- | ----- |
| Storage | $0.01 / GB-month | Computed daily from live byte total per `agent_did`. |
| Restore | $0.05 / op | Charged on `/v1/backup/{id}` and `/v1/backup/restore`. |
| Prepay bundle | $1.00 USDC | Buys an access token; restores draw from the prepaid balance until depletion. |

Settlement: USDC on Base L2.

## Quick reference

```sh
# Create
curl -X POST $HOST/v1/backup/create \
  -H 'content-type: application/json' \
  -d '{"agent_did":"did:hive:agent-42","name":"state.json","body":{"v":1}}'

# List
curl -i "$HOST/v1/backup/list?agent_did=did:hive:agent-42"

# Pay, then restore
curl -X POST $HOST/v1/x402/proof/submit \
  -H 'content-type: application/json' \
  -d '{"nonce":"...","payer":"0x...","chain":"base","tx_hash":"0x..."}'

curl -i "$HOST/v1/backup/<id>" -H "X-Hive-Access: hive_..."
```

## Configuration

| Variable | Default |
| -------- | ------- |
| `PORT` | `3000` |
| `ENABLE` | `true` |
| `WALLET_ADDRESS` | `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` |
| `BACKUP_PRICE_PER_GB_MONTH_USD` | `0.01` |
| `BACKUP_PRICE_PER_RESTORE_USD` | `0.05` |
| `BACKUP_PREPAY_BUNDLE_USD` | `1.0` |
| `BACKUP_MAX_OBJECT_BYTES` | `10485760` |
| `BACKUP_DB_PATH` | `/tmp/backup.db` |
| `BACKUP_BLOB_DIR` | `/tmp/backup_blobs` |

## License

MIT.
