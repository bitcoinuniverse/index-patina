/**
 * Storage.
 *
 * SQLite is the default store so the service runs with nothing else installed.
 * Every statement of DDL lives in migrations.ts, and every query lives here, so
 * a second adapter has one file of SQL to port rather than a search across the
 * codebase.
 *
 * The apply path is one transaction per block. Either the block row, the
 * derived rows and the undo document all land, or none of them do. There is no
 * state in which a block is half applied.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { MIGRATIONS, MIGRATION_TRACKING_TABLE, EXPECTED_TABLES } from './migrations.js';
import { scriptToAddress } from './address.js';
import type { Network } from './config.js';
import {
  outpointKey,
  parseOutpointKey,
  type Artifact,
  type BlockView,
  type Carrier,
  type Counters,
  type InvalidEvent,
  type PatinaEvent,
  type Ring,
  type Snapshot,
} from './protocol.js';
import { deriveBlockFacts, spendersOf, type BlockFacts, type SeedFact } from './facts.js';

export interface ArtifactRow {
  artifact_id: string;
  birth_txid: string;
  birth_height: number;
  birth_vout: number;
  endowment_sats: number;
  founding: number;
  status: 'ALIVE' | 'RELIC';
  carrier_txid: string | null;
  carrier_vout: number | null;
  carrier_height: number | null;
  carrier_value_sats: number | null;
  carrier_address: string | null;
  claimant_xonly: string;
  salt_hex: string;
  commit_txid: string;
  commit_vout: number;
  commit_height: number;
  ring_count: number;
  relic_height: number | null;
  updated_height: number;
}

export interface RingRow {
  artifact_id: string;
  ring_index: number;
  start_height: number;
  end_height: number;
  depth: number;
  carried_value_sats: number;
  successor_txid: string | null;
  successor_vout: number | null;
  relic: number;
}

export interface CarrierRow {
  txid: string;
  vout: number;
  height: number;
  value_sats: number;
  script_hex: string;
  address: string | null;
  spent_height: number | null;
  spent_txid: string | null;
}

export interface CommitRow {
  txid: string;
  vout: number;
  height: number | null;
  commitment: string;
  claimant_xonly: string;
  value_sats: number | null;
  status: 'REVEALED' | 'REJECTED';
  reveal_txid: string | null;
  reveal_height: number | null;
  artifact_id: string | null;
  first_seen: number;
}

export interface BlockRow {
  height: number;
  hash: string;
  previous_hash: string | null;
  block_time: number;
  tx_count: number;
  parser_version: string;
  state_root: string;
  prior_state_root: string;
  event_count: number;
  applied_at: number;
}

export interface InvalidEventRow {
  id: number;
  height: number;
  block_index: number;
  sequence: number;
  txid: string;
  reason: string;
  detail: string | null;
}

interface UndoCarrier {
  key: string;
  spent_height: number | null;
  spent_txid: string | null;
}

export interface UndoDocument {
  height: number;
  blockHash: string;
  priorStateRoot: string;
  createdArtifacts: string[];
  priorArtifacts: Artifact[];
  priorArtifactMeta: Record<string, { address: string | null; updatedHeight: number }>;
  createdCarriers: string[];
  spentCarriers: UndoCarrier[];
  createdCommits: string[];
  priorCommits: CommitRow[];
}

export interface ApplyBlockInput {
  readonly view: BlockView;
  readonly prior: Snapshot;
  readonly next: Snapshot;
  readonly events: readonly PatinaEvent[];
  readonly invalidEvents: readonly InvalidEvent[];
  readonly facts: BlockFacts;
  readonly priorStateRoot: string;
  readonly nextStateRoot: string;
  readonly parserVersion: string;
  readonly blockTime: number;
}

export interface StoreOptions {
  readonly path: string;
  readonly network: Network;
  readonly readonly?: boolean;
}

const STATE_KEYS = {
  network: 'network',
  parserVersion: 'parser_version',
  deploymentSpecSha: 'deployment_spec_sha256',
  startHeight: 'start_height',
} as const;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export class Store {
  readonly db: Database.Database;
  readonly network: Network;

  constructor(options: StoreOptions) {
    this.network = options.network;
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path, { readonly: options.readonly === true });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- migrations

  migrate(): number {
    this.db.exec(MIGRATION_TRACKING_TABLE);
    const applied = new Set(
      (this.db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((row) => row.id),
    );
    let count = 0;
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      const run = this.db.transaction(() => {
        for (const statement of migration.statements) this.db.exec(statement);
        this.db
          .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.id, migration.name, Date.now());
      });
      run();
      count += 1;
    }
    return count;
  }

  /** Confirms every expected table exists and that no foreign key is dangling. */
  checkIntegrity(): { tables: string[]; missing: string[]; foreignKeyViolations: number } {
    const tables = (
      this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));
    const missing = EXPECTED_TABLES.filter((name) => !tables.includes(name));
    const violations = this.db.pragma('foreign_key_check') as unknown[];
    return { tables, missing, foreignKeyViolations: violations.length };
  }

  // -------------------------------------------------------------- indexer state

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM indexer_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO indexer_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  /**
   * Binds the database to one network, one parser version and one deployment.
   * A mismatch is refused rather than silently indexed into the same file.
   */
  bind(parserVersion: string, specSha256: string, startHeight: number): void {
    const existingNetwork = this.getState(STATE_KEYS.network);
    if (existingNetwork !== null && existingNetwork !== this.network) {
      throw new StoreError(`database holds ${existingNetwork} data, refusing to open it as ${this.network}`);
    }
    const existingParser = this.getState(STATE_KEYS.parserVersion);
    if (existingParser !== null && existingParser !== parserVersion) {
      throw new StoreError(
        `database was written by parser ${existingParser}, this build is ${parserVersion}. Run reindex.`,
      );
    }
    const existingSpec = this.getState(STATE_KEYS.deploymentSpecSha);
    if (existingSpec !== null && existingSpec !== specSha256) {
      throw new StoreError(
        `database was written against specification ${existingSpec}, this deployment pins ${specSha256}. Run reindex.`,
      );
    }
    this.setState(STATE_KEYS.network, this.network);
    this.setState(STATE_KEYS.parserVersion, parserVersion);
    this.setState(STATE_KEYS.deploymentSpecSha, specSha256);
    if (this.getState(STATE_KEYS.startHeight) === null) this.setState(STATE_KEYS.startHeight, String(startHeight));
  }

  // -------------------------------------------------------------------- blocks

  indexedHeight(): number {
    const row = this.db.prepare('SELECT MAX(height) AS height FROM blocks').get() as { height: number | null };
    return row.height === null ? -1 : row.height;
  }

  firstIndexedHeight(): number {
    const row = this.db.prepare('SELECT MIN(height) AS height FROM blocks').get() as { height: number | null };
    return row.height === null ? -1 : row.height;
  }

  getBlock(height: number): BlockRow | null {
    return (this.db.prepare('SELECT * FROM blocks WHERE height = ?').get(height) as BlockRow | undefined) ?? null;
  }

  getBlockByHash(hash: string): BlockRow | null {
    return (this.db.prepare('SELECT * FROM blocks WHERE hash = ?').get(hash) as BlockRow | undefined) ?? null;
  }

  tipBlock(): BlockRow | null {
    return (
      (this.db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get() as BlockRow | undefined) ?? null
    );
  }

  blockRoots(fromHeight: number, toHeight: number): { height: number; hash: string; state_root: string }[] {
    return this.db
      .prepare('SELECT height, hash, state_root FROM blocks WHERE height >= ? AND height <= ? ORDER BY height')
      .all(fromHeight, toHeight) as { height: number; hash: string; state_root: string }[];
  }

  // ------------------------------------------------------------------ snapshot

  /** Rebuild the reducer snapshot from the canonical tables. */
  loadSnapshot(): Snapshot {
    const tip = this.tipBlock();
    if (tip === null) {
      return { height: -1, blockHash: null, artifacts: {}, carriers: {}, counters: zeroCounters() };
    }
    const artifactRows = this.db.prepare('SELECT * FROM artifacts ORDER BY artifact_id').all() as ArtifactRow[];
    const ringRows = this.db.prepare('SELECT * FROM rings ORDER BY artifact_id, ring_index').all() as RingRow[];

    const ringsById = new Map<string, Ring[]>();
    for (const row of ringRows) {
      const bucket = ringsById.get(row.artifact_id) ?? [];
      bucket.push(ringFromRow(row));
      ringsById.set(row.artifact_id, bucket);
    }

    const artifacts: Record<string, Artifact> = {};
    const carriers: Record<string, string[]> = {};
    for (const row of artifactRows) {
      const artifact = artifactFromRow(row, ringsById.get(row.artifact_id) ?? []);
      artifacts[row.artifact_id] = artifact;
      if (artifact.carrier !== null) {
        const key = outpointKey(artifact.carrier.txid, artifact.carrier.vout);
        const bucket = carriers[key] ?? [];
        bucket.push(row.artifact_id);
        carriers[key] = bucket;
      }
    }
    for (const key of Object.keys(carriers)) carriers[key].sort();

    return {
      height: tip.height,
      blockHash: tip.hash,
      artifacts,
      carriers,
      counters: countersFrom(artifacts, tip.height),
    };
  }

  // ----------------------------------------------------------------- apply path

  applyBlock(input: ApplyBlockInput): void {
    const run = this.db.transaction(() => this.applyBlockInner(input));
    run();
  }

  private applyBlockInner(input: ApplyBlockInput): void {
    const { view, prior, next, events, invalidEvents, facts } = input;
    const height = view.height;
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO blocks (height, hash, previous_hash, block_time, tx_count, parser_version,
                             state_root, prior_state_root, event_count, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        height,
        view.hash,
        view.prevHash ?? null,
        input.blockTime,
        view.txs.length,
        input.parserVersion,
        input.nextStateRoot,
        input.priorStateRoot,
        events.length,
        now,
      );

    const insertTx = this.db.prepare(
      `INSERT INTO transactions (txid, block_height, block_index, kind, marker_version, marker_op,
                                 marker_vout, marker_payload_hex, valid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const fact of facts.txs) {
      insertTx.run(
        fact.txid,
        height,
        fact.txIndex,
        fact.kind,
        fact.markerVersion,
        fact.markerOp,
        fact.markerVout,
        fact.markerPayloadHex,
        fact.valid ? 1 : 0,
      );
    }

    const insertInvalid = this.db.prepare(
      `INSERT INTO invalid_events (height, block_index, sequence, txid, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    invalidEvents.forEach((event, sequence) => {
      insertInvalid.run(height, event.txIndex, sequence, event.txid, event.reason, event.detail);
    });

    // Carriers created by this block, in event order and deduplicated.
    const createdCarriers: string[] = [];
    const seenCarrier = new Set<string>();
    const insertCarrier = this.db.prepare(
      `INSERT INTO carriers (txid, vout, height, value_sats, script_hex, address, spent_height, spent_txid)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (txid, vout) DO NOTHING`,
    );
    for (const event of events) {
      if (event.vout === null) continue;
      const key = outpointKey(event.txid, event.vout);
      if (seenCarrier.has(key)) continue;
      seenCarrier.add(key);
      const script = facts.outputScripts.get(key);
      if (script === undefined) {
        throw new StoreError(`block ${height} has no output script for carrier ${key}`);
      }
      const address = scriptToAddress(script, this.network);
      const info = insertCarrier.run(event.txid, event.vout, height, event.value, script, address);
      if (info.changes > 0) createdCarriers.push(key);
    }

    // Carriers this block retired: anything live before or created here that is
    // not live after.
    const spenders = spendersOf(view);
    const finalKeys = new Set(Object.keys(next.carriers));
    const candidates = new Set<string>([...Object.keys(prior.carriers), ...seenCarrier]);
    const spentCarriers: UndoCarrier[] = [];
    const selectCarrier = this.db.prepare('SELECT spent_height, spent_txid FROM carriers WHERE txid = ? AND vout = ?');
    const markSpent = this.db.prepare(
      'UPDATE carriers SET spent_height = ?, spent_txid = ? WHERE txid = ? AND vout = ?',
    );
    for (const key of [...candidates].sort()) {
      if (finalKeys.has(key)) continue;
      const spender = spenders.get(key);
      if (spender === undefined) continue;
      const { txid, vout } = parseOutpointKey(key);
      const before = selectCarrier.get(txid, vout) as { spent_height: number | null; spent_txid: string | null } | undefined;
      if (before === undefined) continue;
      spentCarriers.push({ key, spent_height: before.spent_height, spent_txid: before.spent_txid });
      markSpent.run(height, spender, txid, vout);
    }

    // Artifacts and rings for everything the block touched.
    const affected = [...new Set(events.map((event) => event.artifactId))].sort();
    const createdArtifacts: string[] = [];
    const priorArtifacts: Artifact[] = [];
    const priorArtifactMeta: Record<string, { address: string | null; updatedHeight: number }> = {};
    const selectArtifact = this.db.prepare('SELECT carrier_address, updated_height FROM artifacts WHERE artifact_id = ?');

    for (const id of affected) {
      const before = prior.artifacts[id];
      if (before === undefined) {
        createdArtifacts.push(id);
      } else {
        priorArtifacts.push(before);
        const meta = selectArtifact.get(id) as { carrier_address: string | null; updated_height: number } | undefined;
        priorArtifactMeta[id] = {
          address: meta ? meta.carrier_address : null,
          updatedHeight: meta ? meta.updated_height : before.birthHeight,
        };
      }
    }

    for (const id of affected) {
      const artifact = next.artifacts[id];
      if (artifact === undefined) throw new StoreError(`event names artifact ${id} which is absent after the block`);
      const seed = facts.seeds.get(id);
      const isNew = prior.artifacts[id] === undefined;
      if (isNew && seed === undefined) {
        throw new StoreError(`artifact ${id} was created at height ${height} without SEED facts`);
      }
      this.writeArtifact(artifact, height, seed, isNew);
    }

    // Commit reveals recorded by this block.
    const createdCommits: string[] = [];
    const priorCommits: CommitRow[] = [];
    const selectCommit = this.db.prepare('SELECT * FROM commits WHERE txid = ? AND vout = ?');
    const upsertCommit = this.db.prepare(
      `INSERT INTO commits (txid, vout, height, commitment, claimant_xonly, value_sats, status,
                            reveal_txid, reveal_height, artifact_id, first_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (txid, vout) DO UPDATE SET
         height = excluded.height,
         commitment = excluded.commitment,
         claimant_xonly = excluded.claimant_xonly,
         value_sats = excluded.value_sats,
         status = excluded.status,
         reveal_txid = excluded.reveal_txid,
         reveal_height = excluded.reveal_height,
         artifact_id = excluded.artifact_id`,
    );
    for (const commit of facts.commits) {
      const key = outpointKey(commit.txid, commit.vout);
      const before = selectCommit.get(commit.txid, commit.vout) as CommitRow | undefined;
      if (before === undefined) createdCommits.push(key);
      else priorCommits.push(before);
      upsertCommit.run(
        commit.txid,
        commit.vout,
        commit.height,
        commit.commitment,
        commit.claimantXOnly,
        commit.valueSats,
        commit.status,
        commit.revealTxid,
        commit.revealHeight,
        commit.artifactId,
        now,
      );
    }

    const undo: UndoDocument = {
      height,
      blockHash: view.hash,
      priorStateRoot: input.priorStateRoot,
      createdArtifacts,
      priorArtifacts,
      priorArtifactMeta,
      createdCarriers,
      spentCarriers,
      createdCommits,
      priorCommits,
    };
    this.db
      .prepare('INSERT INTO block_undo (height, block_hash, prior_state_root, document) VALUES (?, ?, ?, ?)')
      .run(height, view.hash, input.priorStateRoot, JSON.stringify(undo));
  }

  private writeArtifact(
    artifact: Artifact,
    height: number,
    seed: SeedFact | undefined,
    isNew: boolean,
  ): void {
    const carrier = artifact.carrier;
    const address =
      carrier === null
        ? null
        : ((this.db.prepare('SELECT address FROM carriers WHERE txid = ? AND vout = ?').get(carrier.txid, carrier.vout) as
            | { address: string | null }
            | undefined)?.address ?? null);

    if (isNew) {
      if (seed === undefined) throw new StoreError(`artifact ${artifact.artifactId} needs SEED facts`);
      this.db
        .prepare(
          `INSERT INTO artifacts (artifact_id, birth_txid, birth_height, birth_vout, endowment_sats, founding,
                                  status, carrier_txid, carrier_vout, carrier_height, carrier_value_sats,
                                  carrier_address, claimant_xonly, salt_hex, commit_txid, commit_vout,
                                  commit_height, ring_count, relic_height, updated_height)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.artifactId,
          artifact.birthTxid,
          artifact.birthHeight,
          artifact.birthVout,
          artifact.endowmentSats,
          artifact.founding ? 1 : 0,
          artifact.status,
          carrier?.txid ?? null,
          carrier?.vout ?? null,
          carrier?.height ?? null,
          carrier?.value ?? null,
          address,
          seed.claimantXOnly,
          seed.saltHex,
          seed.commitTxid,
          seed.commitVout,
          seed.commitHeight,
          artifact.rings.length,
          artifact.status === 'RELIC' ? height : null,
          height,
        );
    } else {
      this.db
        .prepare(
          `UPDATE artifacts SET status = ?, carrier_txid = ?, carrier_vout = ?, carrier_height = ?,
                                carrier_value_sats = ?, carrier_address = ?, ring_count = ?,
                                relic_height = ?, updated_height = ?
           WHERE artifact_id = ?`,
        )
        .run(
          artifact.status,
          carrier?.txid ?? null,
          carrier?.vout ?? null,
          carrier?.height ?? null,
          carrier?.value ?? null,
          address,
          artifact.rings.length,
          artifact.status === 'RELIC' ? height : null,
          height,
          artifact.artifactId,
        );
    }

    this.db.prepare('DELETE FROM carrier_artifacts WHERE artifact_id = ?').run(artifact.artifactId);
    if (carrier !== null) {
      this.db
        .prepare(
          `INSERT INTO carrier_artifacts (carrier_txid, carrier_vout, artifact_id, since_height)
           VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(carrier.txid, carrier.vout, artifact.artifactId, carrier.height);
    }

    this.db.prepare('DELETE FROM rings WHERE artifact_id = ?').run(artifact.artifactId);
    const insertRing = this.db.prepare(
      `INSERT INTO rings (artifact_id, ring_index, start_height, end_height, depth, carried_value_sats,
                          successor_txid, successor_vout, relic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ring of artifact.rings) {
      insertRing.run(
        artifact.artifactId,
        ring.index,
        ring.startHeight,
        ring.endHeight,
        ring.depth,
        ring.carriedValue,
        ring.successorTxid,
        ring.successorVout,
        ring.relic ? 1 : 0,
      );
    }
  }

  // ------------------------------------------------------------------ rollback

  getUndo(height: number): UndoDocument | null {
    const row = this.db.prepare('SELECT document FROM block_undo WHERE height = ?').get(height) as
      | { document: string }
      | undefined;
    return row ? (JSON.parse(row.document) as UndoDocument) : null;
  }

  /**
   * Undo one block. Returns the state root the database should hold afterwards,
   * taken from the undo document rather than recomputed, so the caller can
   * verify the rollback against a value written before the block was applied.
   */
  rollbackBlock(height: number): string {
    const undo = this.getUndo(height);
    if (undo === null) throw new StoreError(`no undo document for height ${height}, cannot roll back`);
    const run = this.db.transaction(() => {
      for (const id of undo.createdArtifacts) {
        this.db.prepare('DELETE FROM artifacts WHERE artifact_id = ?').run(id);
      }
      for (const artifact of undo.priorArtifacts) {
        const meta = undo.priorArtifactMeta[artifact.artifactId];
        this.restoreArtifact(artifact, meta?.address ?? null, meta?.updatedHeight ?? artifact.birthHeight);
      }
      for (const key of undo.createdCarriers) {
        const { txid, vout } = parseOutpointKey(key);
        this.db.prepare('DELETE FROM carriers WHERE txid = ? AND vout = ?').run(txid, vout);
      }
      for (const carrier of undo.spentCarriers) {
        const { txid, vout } = parseOutpointKey(carrier.key);
        this.db
          .prepare('UPDATE carriers SET spent_height = ?, spent_txid = ? WHERE txid = ? AND vout = ?')
          .run(carrier.spent_height, carrier.spent_txid, txid, vout);
      }
      for (const key of undo.createdCommits) {
        const { txid, vout } = parseOutpointKey(key);
        this.db.prepare('DELETE FROM commits WHERE txid = ? AND vout = ?').run(txid, vout);
      }
      for (const commit of undo.priorCommits) {
        this.db
          .prepare(
            `UPDATE commits SET height = ?, commitment = ?, claimant_xonly = ?, value_sats = ?, status = ?,
                                reveal_txid = ?, reveal_height = ?, artifact_id = ?
             WHERE txid = ? AND vout = ?`,
          )
          .run(
            commit.height,
            commit.commitment,
            commit.claimant_xonly,
            commit.value_sats,
            commit.status,
            commit.reveal_txid,
            commit.reveal_height,
            commit.artifact_id,
            commit.txid,
            commit.vout,
          );
      }
      // Removing the block row cascades transactions, invalid events and the
      // undo document itself.
      this.db.prepare('DELETE FROM blocks WHERE height = ?').run(height);
      this.db.prepare('DELETE FROM checkpoints WHERE height >= ?').run(height);
    });
    run();
    return undo.priorStateRoot;
  }

  private restoreArtifact(artifact: Artifact, address: string | null, updatedHeight: number): void {
    const carrier = artifact.carrier;
    this.db
      .prepare(
        `UPDATE artifacts SET status = ?, carrier_txid = ?, carrier_vout = ?, carrier_height = ?,
                              carrier_value_sats = ?, carrier_address = ?, ring_count = ?,
                              relic_height = ?, updated_height = ?
         WHERE artifact_id = ?`,
      )
      .run(
        artifact.status,
        carrier?.txid ?? null,
        carrier?.vout ?? null,
        carrier?.height ?? null,
        carrier?.value ?? null,
        address,
        artifact.rings.length,
        artifact.status === 'RELIC' ? artifact.rings[artifact.rings.length - 1]?.endHeight ?? null : null,
        updatedHeight,
        artifact.artifactId,
      );

    this.db.prepare('DELETE FROM carrier_artifacts WHERE artifact_id = ?').run(artifact.artifactId);
    if (carrier !== null) {
      this.db
        .prepare(
          `INSERT INTO carrier_artifacts (carrier_txid, carrier_vout, artifact_id, since_height)
           VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(carrier.txid, carrier.vout, artifact.artifactId, carrier.height);
    }

    this.db.prepare('DELETE FROM rings WHERE artifact_id = ?').run(artifact.artifactId);
    const insertRing = this.db.prepare(
      `INSERT INTO rings (artifact_id, ring_index, start_height, end_height, depth, carried_value_sats,
                          successor_txid, successor_vout, relic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ring of artifact.rings) {
      insertRing.run(
        artifact.artifactId,
        ring.index,
        ring.startHeight,
        ring.endHeight,
        ring.depth,
        ring.carriedValue,
        ring.successorTxid,
        ring.successorVout,
        ring.relic ? 1 : 0,
      );
    }
  }

  pruneUndo(belowHeight: number): number {
    const info = this.db.prepare('DELETE FROM block_undo WHERE height < ?').run(belowHeight);
    return info.changes;
  }

  recordReorg(entry: {
    forkHeight: number;
    depth: number;
    oldTipHeight: number;
    oldTipHash: string;
    newTipHash: string | null;
    restoredStateRoot: string;
    rootVerified: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO reorgs (detected_at, fork_height, depth, old_tip_height, old_tip_hash, new_tip_hash,
                             restored_state_root, root_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        entry.forkHeight,
        entry.depth,
        entry.oldTipHeight,
        entry.oldTipHash,
        entry.newTipHash,
        entry.restoredStateRoot,
        entry.rootVerified ? 1 : 0,
      );
  }

  reorgCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reorgs').get() as { n: number }).n;
  }

  recentReorgs(limit: number): unknown[] {
    return this.db.prepare('SELECT * FROM reorgs ORDER BY id DESC LIMIT ?').all(limit);
  }

  // --------------------------------------------------------------- checkpoints

  writeCheckpoint(height: number, hash: string, root: string, counters: Counters): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (height, block_hash, state_root, artifacts_alive, artifacts_relic,
                                  rings_total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (height) DO UPDATE SET block_hash = excluded.block_hash, state_root = excluded.state_root,
           artifacts_alive = excluded.artifacts_alive, artifacts_relic = excluded.artifacts_relic,
           rings_total = excluded.rings_total, created_at = excluded.created_at`,
      )
      .run(height, hash, root, counters.artifactsAlive, counters.artifactsRelic, counters.ringsTotal, Date.now());
  }

  latestCheckpoint(): { height: number; block_hash: string; state_root: string } | null {
    return (
      (this.db.prepare('SELECT * FROM checkpoints ORDER BY height DESC LIMIT 1').get() as
        | { height: number; block_hash: string; state_root: string }
        | undefined) ?? null
    );
  }

  // ------------------------------------------------------------------- queries

  countArtifacts(): { alive: number; relic: number; founding: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'ALIVE' THEN 1 ELSE 0 END) AS alive,
           SUM(CASE WHEN status = 'RELIC' THEN 1 ELSE 0 END) AS relic,
           SUM(founding) AS founding
         FROM artifacts`,
      )
      .get() as { alive: number | null; relic: number | null; founding: number | null };
    return { alive: row.alive ?? 0, relic: row.relic ?? 0, founding: row.founding ?? 0 };
  }

  counters(atHeight: number): Counters {
    const counts = this.countArtifacts();
    const rings = (this.db.prepare('SELECT COUNT(*) AS n FROM rings').get() as { n: number }).n;
    const endowment = (
      this.db.prepare('SELECT COALESCE(SUM(endowment_sats), 0) AS total FROM artifacts').get() as { total: number }
    ).total;
    const deepest = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(? - carrier_height), 0) AS depth FROM artifacts
           WHERE status = 'ALIVE' AND carrier_height IS NOT NULL`,
        )
        .get(atHeight) as { depth: number }
    ).depth;
    return {
      artifactsAlive: counts.alive,
      artifactsRelic: counts.relic,
      foundingTotal: counts.founding,
      ringsTotal: rings,
      deepestLiveDepth: deepest < 0 ? 0 : deepest,
      endowmentTotalSats: endowment,
    };
  }

  invalidEventCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM invalid_events').get() as { n: number }).n;
  }

  getArtifactRow(id: string): ArtifactRow | null {
    return (this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(id) as ArtifactRow | undefined) ?? null;
  }

  getRings(id: string): RingRow[] {
    return this.db.prepare('SELECT * FROM rings WHERE artifact_id = ? ORDER BY ring_index').all(id) as RingRow[];
  }

  /**
   * Artifacts newest first, ordered by (birth_height DESC, artifact_id DESC).
   * Returns `limit + 1` rows so the caller can build the next cursor.
   */
  listArtifacts(filters: {
    limit: number;
    cursorHeight?: number;
    cursorId?: string;
    founding?: boolean;
    status?: 'ALIVE' | 'RELIC';
    address?: string;
  }): ArtifactRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.cursorHeight !== undefined && filters.cursorId !== undefined) {
      where.push('(birth_height < ? OR (birth_height = ? AND artifact_id < ?))');
      params.push(filters.cursorHeight, filters.cursorHeight, filters.cursorId);
    }
    if (filters.founding !== undefined) {
      where.push('founding = ?');
      params.push(filters.founding ? 1 : 0);
    }
    if (filters.status !== undefined) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.address !== undefined) {
      where.push('carrier_address = ?');
      params.push(filters.address);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(filters.limit + 1);
    return this.db
      .prepare(`SELECT * FROM artifacts ${clause} ORDER BY birth_height DESC, artifact_id DESC LIMIT ?`)
      .all(...params) as ArtifactRow[];
  }

  holdings(address: string): ArtifactRow[] {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE carrier_address = ? AND status = 'ALIVE' ORDER BY birth_height, artifact_id")
      .all(address) as ArtifactRow[];
  }

  getCarrier(txid: string, vout: number): CarrierRow | null {
    return (
      (this.db.prepare('SELECT * FROM carriers WHERE txid = ? AND vout = ?').get(txid, vout) as
        | CarrierRow
        | undefined) ?? null
    );
  }

  artifactsOnCarrier(txid: string, vout: number): ArtifactRow[] {
    return this.db
      .prepare(
        `SELECT a.* FROM artifacts a
         JOIN carrier_artifacts ca ON ca.artifact_id = a.artifact_id
         WHERE ca.carrier_txid = ? AND ca.carrier_vout = ?
         ORDER BY a.artifact_id`,
      )
      .all(txid, vout) as ArtifactRow[];
  }

  /** Longest completed rings, deepest first. */
  museum(limit: number, cursorDepth?: number, cursorKey?: string): (RingRow & { founding: number })[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (cursorDepth !== undefined && cursorKey !== undefined) {
      where.push('(r.depth < ? OR (r.depth = ? AND (r.artifact_id || \':\' || r.ring_index) < ?))');
      params.push(cursorDepth, cursorDepth, cursorKey);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit + 1);
    return this.db
      .prepare(
        `SELECT r.*, a.founding AS founding FROM rings r
         JOIN artifacts a ON a.artifact_id = r.artifact_id
         ${clause}
         ORDER BY r.depth DESC, r.artifact_id DESC, r.ring_index DESC LIMIT ?`,
      )
      .all(...params) as (RingRow & { founding: number })[];
  }

  /** Deepest live stretches. Depth is height minus carrier height at query time. */
  leaderboard(limit: number, foundingOnly: boolean): ArtifactRow[] {
    const clause = foundingOnly ? 'AND founding = 1' : '';
    return this.db
      .prepare(
        `SELECT * FROM artifacts WHERE status = 'ALIVE' AND carrier_height IS NOT NULL ${clause}
         ORDER BY carrier_height ASC, artifact_id ASC LIMIT ?`,
      )
      .all(limit) as ArtifactRow[];
  }

  /** Rings closed most recently first. */
  shatter(limit: number, cursorHeight?: number, cursorKey?: string): (RingRow & { founding: number })[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (cursorHeight !== undefined && cursorKey !== undefined) {
      where.push('(r.end_height < ? OR (r.end_height = ? AND (r.artifact_id || \':\' || r.ring_index) < ?))');
      params.push(cursorHeight, cursorHeight, cursorKey);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit + 1);
    return this.db
      .prepare(
        `SELECT r.*, a.founding AS founding FROM rings r
         JOIN artifacts a ON a.artifact_id = r.artifact_id
         ${clause}
         ORDER BY r.end_height DESC, r.artifact_id DESC, r.ring_index DESC LIMIT ?`,
      )
      .all(...params) as (RingRow & { founding: number })[];
  }

  listInvalidEvents(limit: number, cursorId?: number, reason?: string): InvalidEventRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (cursorId !== undefined) {
      where.push('id < ?');
      params.push(cursorId);
    }
    if (reason !== undefined) {
      where.push('reason = ?');
      params.push(reason);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit + 1);
    return this.db
      .prepare(`SELECT * FROM invalid_events ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params) as InvalidEventRow[];
  }

  invalidEventBreakdown(): { reason: string; count: number }[] {
    return this.db
      .prepare('SELECT reason, COUNT(*) AS count FROM invalid_events GROUP BY reason ORDER BY count DESC, reason')
      .all() as { reason: string; count: number }[];
  }

  getCommit(txid: string, vout: number): CommitRow | null {
    return (
      (this.db.prepare('SELECT * FROM commits WHERE txid = ? AND vout = ?').get(txid, vout) as CommitRow | undefined) ??
      null
    );
  }

  /** Every artifact with its rings, for the deterministic census computation. */
  allArtifactHistories(): { artifact: ArtifactRow; rings: RingRow[] }[] {
    const artifacts = this.db.prepare('SELECT * FROM artifacts ORDER BY artifact_id').all() as ArtifactRow[];
    const rings = this.db.prepare('SELECT * FROM rings ORDER BY artifact_id, ring_index').all() as RingRow[];
    const byId = new Map<string, RingRow[]>();
    for (const ring of rings) {
      const bucket = byId.get(ring.artifact_id) ?? [];
      bucket.push(ring);
      byId.set(ring.artifact_id, bucket);
    }
    return artifacts.map((artifact) => ({ artifact, rings: byId.get(artifact.artifact_id) ?? [] }));
  }

  // ------------------------------------------------------------- attestations

  recordAttestation(entry: {
    artifactId: string;
    blockHash: string;
    message: string;
    address: string;
    signature: string;
    verified: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attestations (artifact_id, block_hash, message, address, signature, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (artifact_id, block_hash, address) DO UPDATE SET
           signature = excluded.signature, verified = excluded.verified, created_at = excluded.created_at`,
      )
      .run(entry.artifactId, entry.blockHash, entry.message, entry.address, entry.signature, entry.verified ? 1 : 0, Date.now());
  }

  attestationsFor(artifactId: string): unknown[] {
    return this.db
      .prepare('SELECT artifact_id, block_hash, address, verified, created_at FROM attestations WHERE artifact_id = ? ORDER BY id')
      .all(artifactId);
  }
}

// ------------------------------------------------------------------- helpers

export function zeroCounters(): Counters {
  return {
    artifactsAlive: 0,
    artifactsRelic: 0,
    foundingTotal: 0,
    ringsTotal: 0,
    deepestLiveDepth: 0,
    endowmentTotalSats: 0,
  };
}

export function ringFromRow(row: RingRow): Ring {
  return {
    index: row.ring_index,
    startHeight: row.start_height,
    endHeight: row.end_height,
    depth: row.depth,
    carriedValue: row.carried_value_sats,
    successorTxid: row.successor_txid,
    successorVout: row.successor_vout,
    relic: row.relic === 1,
  };
}

export function artifactFromRow(row: ArtifactRow, rings: Ring[]): Artifact {
  const carrier: Carrier | null =
    row.carrier_txid === null || row.carrier_vout === null || row.carrier_height === null
      ? null
      : {
          txid: row.carrier_txid,
          vout: row.carrier_vout,
          height: row.carrier_height,
          value: row.carrier_value_sats ?? 0,
        };
  return {
    artifactId: row.artifact_id,
    birthTxid: row.birth_txid,
    birthHeight: row.birth_height,
    birthVout: row.birth_vout,
    endowmentSats: row.endowment_sats,
    founding: row.founding === 1,
    status: row.status,
    carrier,
    rings,
  };
}

/**
 * Counters over a rebuilt snapshot. The result is checked against the state
 * root the reducer wrote, so a disagreement is caught at startup rather than
 * being served to clients.
 */
export function countersFrom(artifacts: Record<string, Artifact>, height: number): Counters {
  let artifactsAlive = 0;
  let artifactsRelic = 0;
  let foundingTotal = 0;
  let ringsTotal = 0;
  let deepestLiveDepth = 0;
  let endowmentTotalSats = 0;
  for (const id of Object.keys(artifacts).sort()) {
    const artifact = artifacts[id];
    if (artifact.status === 'ALIVE') {
      artifactsAlive += 1;
      const depth = artifact.carrier === null ? 0 : height - artifact.carrier.height;
      if (depth > deepestLiveDepth) deepestLiveDepth = depth;
    } else {
      artifactsRelic += 1;
    }
    if (artifact.founding) foundingTotal += 1;
    ringsTotal += artifact.rings.length;
    endowmentTotalSats += artifact.endowmentSats;
  }
  return { artifactsAlive, artifactsRelic, foundingTotal, ringsTotal, deepestLiveDepth, endowmentTotalSats };
}

export { deriveBlockFacts };
