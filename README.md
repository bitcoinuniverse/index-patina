# index-patina

A Bitcoin indexer and read API for the PATINA protocol.

It reads blocks from Bitcoin Core, derives PATINA state deterministically, and
serves that state over HTTP. It holds no keys, signs nothing and broadcasts
nothing.

Every consensus decision comes from `@bitcoinuniverse/patina`. This repository
contains no protocol rules. If you are looking for what makes a SEED valid or
how a successor is chosen, read the protocol package, not this one.

## How it works

The ingest path is four steps and nothing else:

```
getblock -> resolver -> BlockView -> applyBlock -> store
```

- The **resolver** is the only step that touches the network. It fills in every
  input's prevout value, prevout script, creation height and witness.
- **applyBlock** comes from the protocol package. It is pure: no clock, no
  socket, no disk, no randomness.
- The **store** writes one database transaction per block, together with an undo
  document. There is no state in which a block is half applied.

Because of that split, two nodes given the same blocks produce the same state
root at every height, and a reorg is undone by replaying the undo document
rather than by guessing.

## Requirements

- Node 24 or later
- Bitcoin Core with `-txindex=1` and RPC enabled
- Roughly 200 MB of disk for a signet database, more for mainnet

`-txindex=1` is not optional. Deciding whether a commit output is old enough
needs the height of the block that created it, and that lookup goes through
`getrawtransaction`.

## Install and build

The protocol package is currently a relative dependency, so it has to be built
first.

```sh
cd ../../protocols/patina
npm install
npm run build

cd ../../indexers/index-patina
npm install
npm run build
```

## Configure

Copy `.env.example` and edit it. The process collects every configuration
problem and reports them together, then exits with code 2 rather than starting
in a half valid state.

The values you will actually change:

| Variable | Meaning |
| --- | --- |
| `PATINA_NETWORK` | `regtest`, `signet` or `mainnet` |
| `PATINA_BITCOIN_RPC_URL` | Where Core listens |
| `PATINA_BITCOIN_RPC_USER` / `_PASSWORD` | RPC credentials, or use `PATINA_BITCOIN_RPC_COOKIE_FILE` |
| `PATINA_DATA_DIR` | Where the SQLite database lives |
| `PATINA_API_HOST` / `PATINA_API_PORT` | Where the API listens |
| `PATINA_START_HEIGHT` | First height to index, defaults to the window opening height minus the minimum commit age |

### Mainnet

Mainnet is fail closed. Two things must both be true or the process refuses to
start:

1. `PATINA_MAINNET_AUTHORIZED=true`
2. `PATINA_DEPLOYMENT_FILE` points at a deployment record that names at least
   two distinct approvers and pins the specification hash

The protocol package enforces the same rule on the record independently. A
deployment record looks like this, and the baseline snake case field names are
accepted as well as camel case:

```json
{
  "network": "mainnet",
  "protocol_id": "PTNA",
  "spec_sha256": "64 hex characters",
  "h_open": 900000,
  "h_close": 904032,
  "grace_end": 908064,
  "min_carrier_founding": 100000,
  "min_carrier_open": 10000,
  "commit_min_age": 144,
  "approvers": ["First Approver", "Second Approver"]
}
```

## Run

Sync and serve in one process:

```sh
node bin/index-patina.mjs serve
```

Sync only, for a deployment that separates ingest from reads:

```sh
node bin/index-patina.mjs sync
```

Serve an already indexed database with no node attached:

```sh
PATINA_RPC_OFFLINE=true node bin/index-patina.mjs serve --api-only
```

Both long running commands handle `SIGINT` and `SIGTERM`. They finish the block
in flight, close the HTTP listener, close the database and exit 0.

## Commands

| Command | What it does |
| --- | --- |
| `sync` | Backfill history, then follow the tip. `--once` runs a single pass and exits. |
| `serve` | Serve the read API. Also syncs unless `--api-only` is given. |
| `reindex` | Drop every derived row and rebuild from the start height. |
| `reindex-range --from N [--to M]` | Roll back to `N-1` and rebuild forward. |
| `verify` | Replay every stored block and compare the recomputed state root with the stored one. Exit 1 on any mismatch. |
| `status` | Print heights, counters and schema integrity. `--json` for machine output. |

## API

Base path `/patina`. Satoshi values serialize as decimal strings. Heights
serialize as numbers. The full document is at `/openapi.json`.

| Method and path | Returns |
| --- | --- |
| `GET /status` | network, deployment hash, heights, sync flag, parser version, counters |
| `GET /window` | founding window state, bounds, blocks remaining, founding total |
| `GET /artifacts` | page of artifacts, filters `founding`, `status`, `address` |
| `GET /artifacts/:id` | one artifact with depth, tier, next tier and rings |
| `GET /artifacts/:id/card` | share card payload |
| `GET /addresses/:address/holdings` | artifacts whose carrier pays that address |
| `GET /carriers/:txid/:vout` | one carrier and what rests on it |
| `GET /census/current`, `GET /census/:epoch` | survival table for a 2016 block epoch |
| `GET /museum` | longest completed rings |
| `GET /leaderboard?scope=all\|founding` | deepest live stretches |
| `GET /shatter` | rings closed, newest first |
| `GET /invalid-events` | rejected attempts with frozen reason codes, filter by `reason` |
| `GET /stats` | counters, tier distribution, invalid event breakdown |
| `GET /mempool` | provisional overlay, never part of canonical state |
| `POST /safety/outpoints` | classify outpoints as `carrier`, `commit` or `none`, nothing stored |
| `GET /health`, `GET /ready`, `GET /metrics` | also served at the root path |

Paged endpoints take `cursor` and `limit` and return `{ items, next_cursor }`.
A cursor is opaque and encodes the exact sort key of the page boundary, so a
new block landing between requests cannot make a page skip or repeat a row.

`POST /safety/outpoints` takes `{ "outpoints": ["txid:vout"] }`, up to 500 at
a time. Nothing from the request body is stored, logged or cached, and the
response carries `Cache-Control: no-store`. Use it before building a
transaction so a wallet does not spend a live carrier by accident.

## Monitoring

`GET /metrics` returns Prometheus text. The series worth alerting on:

| Series | Alert when |
| --- | --- |
| `patina_tip_lag_blocks` | above 3 for more than a few minutes |
| `patina_synced` | 0 for more than a few minutes |
| `patina_rpc_failures_total` | rising |
| `patina_reorgs_total` | rising faster than the network reorg rate |
| `patina_api_errors_total` | any increase |
| `patina_api_request_duration_seconds` | p99 above your budget |

Also published: `patina_indexed_height`, `patina_tip_height`,
`patina_artifacts_alive`, `patina_artifacts_relic`, `patina_founding_total`,
`patina_rings_total`, `patina_deepest_live_depth`,
`patina_endowment_total_sats`, `patina_invalid_events_total`,
`patina_mempool_entries`, `patina_blocks_applied_total`,
`patina_blocks_rolled_back_total`.

`GET /ready` returns 503 until the schema is complete, at least one block is
indexed and the tip lag is 2 blocks or less. Use it as the readiness probe and
`GET /health` as the liveness probe.

Logs are one JSON object per line on stdout.

## Incident actions

**The indexer refuses to start with a state root mismatch.** The state rebuilt
from the tables disagrees with the root the reducer recorded for the tip block.
Do not serve from it. Run `verify` to find the first height that diverges, then
`reindex-range --from <that height>`. If the divergence starts at the first
indexed block, run `reindex`.

**A reorg was deeper than `PATINA_MAX_REORG_DEPTH`.** The process stops instead
of rolling back blindly. Confirm with your node how deep the reorg actually
went, then run `reindex-range --from <fork height + 1>`.

**A reorg reached past the retained undo window.** Undo documents below
`PATINA_UNDO_RETENTION_BLOCKS` are pruned. Run
`reindex-range --from <fork height + 1>`, which rebuilds from chain data rather
than from undo documents.

**The database was written by a different parser or specification.** Startup
fails with the two versions named. This is the expected behaviour after a
protocol package upgrade. Run `reindex`.

**Sync stops with "prevout has no confirmed creation height".** Core is
running without `-txindex=1`, or the parent transaction has been pruned. Enable
the transaction index and restart.

**Tip lag keeps growing.** Check `patina_rpc_failures_total` and the Core logs
first. The indexer applies blocks one at a time and will catch up on its own
once Core answers.

**Counters look wrong but the roots match.** The roots are the source of truth.
Counters are derived from the same rows and are checked against the tip root at
startup. If `verify` is clean, the state is correct.

## Data model

One SQLite file, sixteen tables, all DDL in `src/migrations.ts`.

- `blocks`, `transactions`, `block_undo`, `checkpoints`, `reorgs`,
  `indexer_state`, `schema_migrations` track ingest.
- `artifacts`, `rings`, `carriers`, `carrier_artifacts`, `commits`,
  `invalid_events`, `attestations` hold derived state.
- `mempool_entries`, `mempool_replacements`, `mempool_conflicts` hold the
  provisional overlay. The mempool path never writes to a canonical table.

Satoshi amounts are stored as SQL `INTEGER`. The whole supply is 2.1e15
satoshis, below 2^53, so no value loses precision.

The SQL is written in the portable subset, with `AUTOINCREMENT` as the one
dialect specific keyword, so a MySQL adapter is a single file to port.

## Development

```sh
npm run typecheck
npm run build
npm test
```

The test suite runs without a Bitcoin node. It drives a synthetic regtest chain
through the offline RPC client, so the real resolver, the real reducer and the
real store are exercised end to end. Nothing between the RPC boundary and the
database is replaced.

## Docker

The image build needs both this repository and the protocol package in the
context. `docker-compose.yml` already sets that up.

```sh
docker compose up -d indexer              # indexer only, point it at your node
docker compose --profile core up -d       # indexer plus a regtest Bitcoin Core
```

## Licence

MIT. See `LICENSE`.
