/**
 * Every statement of DDL in the service lives here.
 *
 * The SQL is written in the portable subset both SQLite and MySQL accept once
 * the small dialect differences are substituted. Nothing uses SQLite specific
 * expressions in a table definition, integer primary keys are declared
 * explicitly rather than relying on rowid, and JSON documents are stored as
 * TEXT. That keeps the door open for a MySQL adapter without a rewrite.
 *
 * Satoshi amounts are stored as SQL INTEGER. The maximum supply is
 * 2 100 000 000 000 000 sats, which is below 2^53, so an int64 column and a
 * JavaScript number both hold it exactly. The API renders them as decimal
 * strings, which is a serialization concern, not a storage concern.
 */

export interface MigrationDatabase {
  exec(sql: string): unknown;
}

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly statements: readonly string[];
}

const INITIAL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS indexer_state (
    key TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS blocks (
    height INTEGER NOT NULL PRIMARY KEY,
    hash TEXT NOT NULL,
    previous_hash TEXT,
    block_time INTEGER NOT NULL,
    tx_count INTEGER NOT NULL,
    parser_version TEXT NOT NULL,
    state_root TEXT NOT NULL,
    prior_state_root TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    CHECK (height >= 0),
    CHECK (tx_count >= 0),
    CHECK (event_count >= 0),
    CHECK (length(hash) = 64)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash ON blocks (hash)`,

  `CREATE TABLE IF NOT EXISTS transactions (
    txid TEXT NOT NULL,
    block_height INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    marker_version INTEGER,
    marker_op INTEGER,
    marker_vout INTEGER,
    marker_payload_hex TEXT,
    valid INTEGER NOT NULL,
    PRIMARY KEY (txid, block_height),
    FOREIGN KEY (block_height) REFERENCES blocks (height) ON DELETE CASCADE,
    CHECK (kind IN ('SEED', 'KEEP', 'CARRIER_SPEND', 'MARKER_ONLY')),
    CHECK (valid IN (0, 1)),
    CHECK (block_index >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_height ON transactions (block_height, block_index)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_kind ON transactions (kind, block_height)`,

  `CREATE TABLE IF NOT EXISTS carriers (
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    height INTEGER NOT NULL,
    value_sats INTEGER NOT NULL,
    script_hex TEXT NOT NULL,
    address TEXT,
    spent_height INTEGER,
    spent_txid TEXT,
    PRIMARY KEY (txid, vout),
    CHECK (vout >= 0),
    CHECK (height >= 0),
    CHECK (value_sats >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_carriers_address ON carriers (address)`,
  `CREATE INDEX IF NOT EXISTS idx_carriers_unspent ON carriers (spent_height)`,

  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT NOT NULL PRIMARY KEY,
    birth_txid TEXT NOT NULL,
    birth_height INTEGER NOT NULL,
    birth_vout INTEGER NOT NULL,
    endowment_sats INTEGER NOT NULL,
    founding INTEGER NOT NULL,
    status TEXT NOT NULL,
    carrier_txid TEXT,
    carrier_vout INTEGER,
    carrier_height INTEGER,
    carrier_value_sats INTEGER,
    carrier_address TEXT,
    claimant_xonly TEXT NOT NULL,
    salt_hex TEXT NOT NULL,
    commit_txid TEXT NOT NULL,
    commit_vout INTEGER NOT NULL,
    commit_height INTEGER NOT NULL,
    ring_count INTEGER NOT NULL,
    relic_height INTEGER,
    updated_height INTEGER NOT NULL,
    CHECK (length(artifact_id) = 64),
    CHECK (founding IN (0, 1)),
    CHECK (status IN ('ALIVE', 'RELIC')),
    CHECK (birth_height >= 0),
    CHECK (endowment_sats >= 0),
    CHECK (ring_count >= 0),
    CHECK ((status = 'ALIVE' AND carrier_txid IS NOT NULL) OR (status = 'RELIC' AND carrier_txid IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts (status, birth_height)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_founding ON artifacts (founding, birth_height)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_carrier ON artifacts (carrier_txid, carrier_vout)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_carrier_address ON artifacts (carrier_address)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_birth ON artifacts (birth_height, artifact_id)`,

  `CREATE TABLE IF NOT EXISTS carrier_artifacts (
    carrier_txid TEXT NOT NULL,
    carrier_vout INTEGER NOT NULL,
    artifact_id TEXT NOT NULL,
    since_height INTEGER NOT NULL,
    PRIMARY KEY (carrier_txid, carrier_vout, artifact_id),
    FOREIGN KEY (carrier_txid, carrier_vout) REFERENCES carriers (txid, vout) ON DELETE CASCADE,
    FOREIGN KEY (artifact_id) REFERENCES artifacts (artifact_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_carrier_artifacts_artifact ON carrier_artifacts (artifact_id)`,

  `CREATE TABLE IF NOT EXISTS rings (
    artifact_id TEXT NOT NULL,
    ring_index INTEGER NOT NULL,
    start_height INTEGER NOT NULL,
    end_height INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    carried_value_sats INTEGER NOT NULL,
    successor_txid TEXT,
    successor_vout INTEGER,
    relic INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, ring_index),
    FOREIGN KEY (artifact_id) REFERENCES artifacts (artifact_id) ON DELETE CASCADE,
    CHECK (ring_index >= 0),
    CHECK (depth >= 0),
    CHECK (end_height >= start_height),
    CHECK (relic IN (0, 1))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rings_depth ON rings (depth)`,
  `CREATE INDEX IF NOT EXISTS idx_rings_end_height ON rings (end_height)`,

  `CREATE TABLE IF NOT EXISTS commits (
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    height INTEGER,
    commitment TEXT NOT NULL,
    claimant_xonly TEXT NOT NULL,
    value_sats INTEGER,
    status TEXT NOT NULL,
    reveal_txid TEXT,
    reveal_height INTEGER,
    artifact_id TEXT,
    first_seen INTEGER NOT NULL,
    PRIMARY KEY (txid, vout),
    CHECK (status IN ('REVEALED', 'REJECTED')),
    CHECK (length(commitment) = 64),
    CHECK (length(claimant_xonly) = 64)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_commits_status ON commits (status)`,
  `CREATE INDEX IF NOT EXISTS idx_commits_reveal ON commits (reveal_height)`,

  `CREATE TABLE IF NOT EXISTS invalid_events (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    height INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    txid TEXT NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT,
    FOREIGN KEY (height) REFERENCES blocks (height) ON DELETE CASCADE,
    CHECK (sequence >= 0)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_invalid_events_unique ON invalid_events (height, block_index, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_invalid_events_recent ON invalid_events (height DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_invalid_events_reason ON invalid_events (reason, height)`,

  `CREATE TABLE IF NOT EXISTS attestations (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    message TEXT NOT NULL,
    address TEXT NOT NULL,
    signature TEXT NOT NULL,
    verified INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (artifact_id) REFERENCES artifacts (artifact_id) ON DELETE CASCADE,
    CHECK (verified IN (0, 1))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_unique ON attestations (artifact_id, block_hash, address)`,

  `CREATE TABLE IF NOT EXISTS mempool_entries (
    txid TEXT NOT NULL PRIMARY KEY,
    kind TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    fee_sats INTEGER,
    vsize INTEGER,
    summary TEXT NOT NULL,
    affected_artifacts TEXT NOT NULL,
    spent_outpoints TEXT NOT NULL,
    CHECK (kind IN ('SEED', 'KEEP', 'CARRIER_SPEND', 'MARKER_ONLY'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mempool_entries_kind ON mempool_entries (kind, first_seen)`,

  `CREATE TABLE IF NOT EXISTS mempool_replacements (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    replaced_txid TEXT NOT NULL,
    replacement_txid TEXT NOT NULL,
    shared_outpoint TEXT NOT NULL,
    detected_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mempool_replacements_unique
     ON mempool_replacements (replaced_txid, replacement_txid)`,

  `CREATE TABLE IF NOT EXISTS mempool_conflicts (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    outpoint TEXT NOT NULL,
    txid_low TEXT NOT NULL,
    txid_high TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    CHECK (txid_low < txid_high)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mempool_conflicts_unique
     ON mempool_conflicts (outpoint, txid_low, txid_high)`,

  `CREATE TABLE IF NOT EXISTS reorgs (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    detected_at INTEGER NOT NULL,
    fork_height INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    old_tip_height INTEGER NOT NULL,
    old_tip_hash TEXT NOT NULL,
    new_tip_hash TEXT,
    restored_state_root TEXT NOT NULL,
    root_verified INTEGER NOT NULL,
    CHECK (depth >= 1),
    CHECK (root_verified IN (0, 1))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reorgs_detected ON reorgs (detected_at DESC)`,

  `CREATE TABLE IF NOT EXISTS block_undo (
    height INTEGER NOT NULL PRIMARY KEY,
    block_hash TEXT NOT NULL,
    prior_state_root TEXT NOT NULL,
    document TEXT NOT NULL,
    FOREIGN KEY (height) REFERENCES blocks (height) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS checkpoints (
    height INTEGER NOT NULL PRIMARY KEY,
    block_hash TEXT NOT NULL,
    state_root TEXT NOT NULL,
    artifacts_alive INTEGER NOT NULL,
    artifacts_relic INTEGER NOT NULL,
    rings_total INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'initial-patina-schema', statements: INITIAL_STATEMENTS },
];

export const MIGRATION_TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/** Names every table the service depends on, used by the integrity check. */
export const EXPECTED_TABLES: readonly string[] = [
  'schema_migrations',
  'indexer_state',
  'blocks',
  'transactions',
  'carriers',
  'artifacts',
  'carrier_artifacts',
  'rings',
  'commits',
  'invalid_events',
  'attestations',
  'mempool_entries',
  'mempool_replacements',
  'mempool_conflicts',
  'reorgs',
  'block_undo',
  'checkpoints',
];
