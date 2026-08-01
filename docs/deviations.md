# Deviations

Every constant, byte layout, derivation, reason code and API contract in the
PATINA implementation baseline is implemented as written. This service changes
none of them, and it restates none of them either: consensus comes from
`@bitcoinuniverse/patina` through `src/protocol.ts`.

## Deviations from the baseline

None.

### Resolved: the baseline once named a version segment in the API base path

The baseline states a naming rule for the whole programme, that no version
labels appear "anywhere in names, paths, packages, URLs, folders, or UI". An
earlier draft of the baseline fixed the indexer API base path at a value that
put a numbered segment in front of the protocol slug, which contradicted that
rule. The baseline was corrected before this service was implemented, and the
base path is `/patina`. This service implements the corrected base path as
written. Nothing in this repository carries a version label: no file, folder,
package or exported symbol. The base path stays
configurable through `PATINA_API_BASE_PATH` for operators who need to mount it
elsewhere.

## Decisions the baseline leaves open

These are choices this repository had to make because the baseline does not
speak to them. None of them changes a protocol value or an observable protocol
outcome. They are recorded here so a reviewer does not have to guess whether
they were deliberate.

### Bitcoin Core must run with `-txindex=1`

The baseline says a SEED is only valid when the commit output is at least
`COMMIT_MIN_AGE` blocks old. Deciding that requires the creation height of the
input being spent, which `getblock` at verbosity 2 does not carry. The resolver
looks the parent transaction up with `getrawtransaction` and takes the height
from the block hash it reports. That needs a transaction index. Without one the
sync stops with an error rather than assuming an age.

### The resolver may call `getblockheader`

The baseline lists the RPC methods the client needs. This service also uses
`getblock` on a parent block hash to turn it into a height, and caches the
result. It reads nothing the listed methods do not already expose.

### Rings are stored without the transaction that closed them

The baseline ring record is
`{ index, start_height, end_height, depth, carried_value, successor_txid, successor_vout, relic }`.
A terminal ring has no successor, so there is no field that names the
transaction which spent the carrier. The `rings` table stores exactly the
baseline fields and nothing invented. The spending transaction is still
recoverable from `carriers.spent_txid`.

### Commit outputs are recorded at reveal, not at creation

A PATINA commit output is an ordinary taproot output until it is spent. Nothing
on chain distinguishes it beforehand. The `commits` table therefore holds
commit outpoints the indexer has actually seen revealed, marked `REVEALED` when
the SEED was accepted and `REJECTED` when a qualifying leaf was revealed but the
SEED failed. `POST /safety/outpoints` also consults the mempool overlay, so an
unconfirmed SEED lets the endpoint flag a commit outpoint before it confirms.

### The census definition

The baseline names a "deterministic survival table per 2016 block epoch" without
fixing its columns. This service computes, for the epoch and an evaluation
height that never exceeds the indexed height: artifacts alive at the epoch
start, artifacts alive at the evaluation height, survivors of both, births,
relics, moves, the deepest live stretch, the endowment held by living artifacts,
and the tier distribution. An epoch the chain has not reached reports zeroes
rather than borrowing counts from an earlier height.

### One endpoint beyond the contract

`GET /patina/mempool` exposes the provisional overlay. It is additive, it is
labelled provisional in its own payload, and it is served with
`Cache-Control: no-store`. Every endpoint the baseline lists is implemented as
specified.

### Aggregate counters are recomputed on load and then checked

Rebuilding the reducer snapshot from SQL requires recomputing the counters the
reducer carries. That computation lives in `src/store.ts`. It is not trusted:
after a rebuild the state root of the rebuilt snapshot is compared with the root
the reducer wrote for the tip block, and a mismatch stops the process with an
instruction to reindex.
