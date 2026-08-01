# Security

## Reporting

Send reports to security@bitcoinuniverse.org. Include the network, the indexed
height, the commit or image tag, and the smallest reproduction you have. Do not
open a public issue for anything that lets a caller read data they should not
see, or that makes the indexer report state the chain does not support.

We acknowledge reports within three working days.

## What this service holds

The indexer holds public chain data and state derived from it. It holds no
keys, no seeds, no descriptors and no user identities. It never signs anything
and never broadcasts a transaction.

The one endpoint that receives caller supplied data is
`POST /patina/safety/outpoints`. The outpoints in that request body are not
written to the database, not logged and not cached. The response carries
`Cache-Control: no-store`.

## Trust boundaries

- **Bitcoin Core** is trusted for chain data. Point the indexer at a node you
  run. A node that lies about block hashes can make the indexer derive state
  the network does not agree with.
- **The protocol package** is trusted for every consensus decision. It is
  pinned by version and its version is written onto every block row. Changing
  it forces a reindex rather than a silent divergence.
- **API callers** are untrusted. Every query parameter, path parameter and
  body field is validated before it reaches SQL. All SQL uses bound parameters.

## Hardening the deployment

- Bind the API to a loopback address or a private network. Put a reverse proxy
  in front of it if it must be public.
- The in process rate limiter is a floor, not a substitute for a proxy limit.
  It is per process and resets when the process restarts.
- Run the container as the unprivileged user it ships with, read only, with
  `no-new-privileges` and all capabilities dropped. `docker-compose.yml` does
  this already.
- Keep the database on a volume you back up. A lost database costs a reindex,
  not data, but a reindex takes as long as the original sync.
- Give Bitcoin Core RPC credentials that are scoped to this service. The
  indexer only reads.

## Mainnet

Mainnet is fail closed and stays that way until an activation authorization
exists. Two conditions must both hold:

1. `PATINA_MAINNET_AUTHORIZED=true`
2. a deployment record at `PATINA_DEPLOYMENT_FILE` that names at least two
   distinct approvers and pins the specification hash

Either one missing is a startup failure with a non zero exit code. The protocol
package applies the same rule to the record independently, so removing the
check in this repository alone does not open the gate.

## Known limits

- The service assumes Bitcoin Core is running with `-txindex=1`. Without it the
  resolver cannot find the creation height of an input spent from an older
  block, and sync stops with an error rather than guessing.
- A reorg deeper than `PATINA_MAX_REORG_DEPTH` stops the process. That is
  deliberate. Roll back deliberately with `reindex-range` after you understand
  what happened.
- Undo documents are pruned below `PATINA_UNDO_RETENTION_BLOCKS`. A reorg that
  reaches past the retained window cannot be undone in place and needs a
  `reindex-range`.
