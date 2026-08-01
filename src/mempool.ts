/**
 * The mempool overlay.
 *
 * Everything in here is provisional. It lives in three tables of its own and
 * never writes to a canonical table, so a client that ignores the overlay sees
 * exactly the state the chain confirmed and nothing else.
 *
 * The overlay answers three questions an operator actually has:
 *   - which unconfirmed transactions would touch a live carrier
 *   - which unconfirmed transaction replaced which other one
 *   - which unconfirmed transactions are fighting over the same outpoint
 */

import type { BitcoinRpc } from './rpc.js';
import type { Resolver } from './resolver.js';
import type { Store } from './store.js';
import {
  decodeMarker,
  outpointKey,
  scanScriptPubKey,
  type Marker,
  type Snapshot,
  type TxView,
} from './protocol.js';

export type MempoolKind = 'SEED' | 'KEEP' | 'CARRIER_SPEND' | 'MARKER_ONLY';

export interface MempoolEntry {
  readonly txid: string;
  readonly kind: MempoolKind;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly affectedArtifacts: readonly string[];
  readonly spentOutpoints: readonly string[];
  readonly summary: MempoolSummary;
}

export interface MempoolSummary {
  readonly markerVout: number | null;
  readonly markerOp: 'SEED' | 'KEEP' | null;
  readonly carrierVout: number | null;
  readonly commitOutpoints: readonly string[];
  readonly outputCount: number;
}

interface MempoolRow {
  txid: string;
  kind: MempoolKind;
  first_seen: number;
  last_seen: number;
  fee_sats: number | null;
  vsize: number | null;
  summary: string;
  affected_artifacts: string;
  spent_outpoints: string;
}

function readMarker(tx: TxView): { vout: number | null; marker: Marker | null } {
  const candidates: number[] = [];
  let payload: Buffer | null = null;
  for (let i = 0; i < tx.outputs.length; i += 1) {
    const scan = scanScriptPubKey(tx.outputs[i].scriptPubKey);
    if (!scan.marker) continue;
    candidates.push(i);
    if (candidates.length === 1 && scan.ok) payload = scan.payload;
  }
  if (candidates.length === 0) return { vout: null, marker: null };
  if (candidates.length > 1 || payload === null) return { vout: candidates[0], marker: null };
  const decoded = decodeMarker(payload);
  return { vout: candidates[0], marker: decoded.ok ? decoded.marker : null };
}

/**
 * Classify a resolved unconfirmed transaction against the confirmed snapshot.
 * Returns null when the transaction plays no protocol role.
 */
export function classify(tx: TxView, snapshot: Snapshot, now: number): MempoolEntry | null {
  const { vout, marker } = readMarker(tx);

  const affected = new Set<string>();
  const spent: string[] = [];
  for (const input of tx.inputs) {
    const key = outpointKey(input.txid, input.vout);
    spent.push(key);
    const ids = snapshot.carriers[key];
    if (ids !== undefined) for (const id of ids) affected.add(id);
  }

  let kind: MempoolKind;
  if (marker !== null) kind = marker.op === 'SEED' ? 'SEED' : 'KEEP';
  else if (vout !== null) kind = 'MARKER_ONLY';
  else if (affected.size > 0) kind = 'CARRIER_SPEND';
  else return null;

  const commitOutpoints: string[] = [];
  if (marker !== null && marker.op === 'SEED') {
    // Any taproot script path input of a pending SEED is a candidate commit.
    // The reveal is not confirmed, so this is reported as provisional, never
    // written to the canonical commits table.
    for (const input of tx.inputs) {
      if ((input.witness?.length ?? 0) >= 2) commitOutpoints.push(outpointKey(input.txid, input.vout));
    }
  }

  return {
    txid: tx.txid,
    kind,
    firstSeen: now,
    lastSeen: now,
    affectedArtifacts: [...affected].sort(),
    spentOutpoints: spent,
    summary: {
      markerVout: vout,
      markerOp: marker === null ? null : marker.op,
      carrierVout: marker !== null && marker.op === 'SEED' ? marker.carrierVout : null,
      commitOutpoints,
      outputCount: tx.outputs.length,
    },
  };
}

export interface MempoolRefreshResult {
  readonly scanned: number;
  readonly tracked: number;
  readonly added: number;
  readonly removed: number;
  readonly replacements: number;
  readonly conflicts: number;
}

export class MempoolOverlay {
  constructor(
    private readonly store: Store,
    private readonly rpc: BitcoinRpc,
    private readonly resolver: Resolver,
  ) {}

  entries(): MempoolEntry[] {
    const rows = this.store.db
      .prepare('SELECT * FROM mempool_entries ORDER BY first_seen, txid')
      .all() as MempoolRow[];
    return rows.map((row) => ({
      txid: row.txid,
      kind: row.kind,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      affectedArtifacts: JSON.parse(row.affected_artifacts) as string[],
      spentOutpoints: JSON.parse(row.spent_outpoints) as string[],
      summary: JSON.parse(row.summary) as MempoolSummary,
    }));
  }

  count(): number {
    return (this.store.db.prepare('SELECT COUNT(*) AS n FROM mempool_entries').get() as { n: number }).n;
  }

  replacements(limit = 50): unknown[] {
    return this.store.db.prepare('SELECT * FROM mempool_replacements ORDER BY id DESC LIMIT ?').all(limit);
  }

  conflicts(limit = 50): unknown[] {
    return this.store.db.prepare('SELECT * FROM mempool_conflicts ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** Provisional commit outpoints seen in unconfirmed SEED transactions. */
  pendingCommitOutpoints(): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of this.entries()) {
      for (const outpoint of entry.summary.commitOutpoints) out.set(outpoint, entry.txid);
    }
    return out;
  }

  /** Provisional carrier spends, keyed by the carrier outpoint being spent. */
  pendingCarrierSpends(): Map<string, MempoolEntry> {
    const out = new Map<string, MempoolEntry>();
    for (const entry of this.entries()) {
      if (entry.affectedArtifacts.length === 0) continue;
      for (const outpoint of entry.spentOutpoints) out.set(outpoint, entry);
    }
    return out;
  }

  clear(): void {
    const run = this.store.db.transaction(() => {
      this.store.db.prepare('DELETE FROM mempool_entries').run();
    });
    run();
  }

  /**
   * Read the node's mempool and rebuild the overlay.
   * Entries that vanished are compared against entries that arrived; when the
   * two share an input, the newcomer is recorded as a replacement.
   */
  async refresh(snapshot: Snapshot, tipHeight: number): Promise<MempoolRefreshResult> {
    const now = Date.now();
    const txids = await this.rpc.getRawMempool();
    const present = new Set(txids);
    const existing = new Map(this.entries().map((entry) => [entry.txid, entry]));

    const added: MempoolEntry[] = [];
    let scanned = 0;

    for (const txid of txids) {
      if (existing.has(txid)) continue;
      const raw = await this.rpc.getMempoolTransaction(txid);
      if (raw === null) continue;
      scanned += 1;
      let view: TxView;
      try {
        view = await this.resolver.resolveMempoolTransaction(raw, tipHeight);
      } catch {
        // A prevout that cannot be resolved means the parent is itself
        // unconfirmed and not yet known. Skip it and pick it up next pass.
        continue;
      }
      const entry = classify(view, snapshot, now);
      if (entry !== null) added.push(entry);
    }

    const removed = [...existing.values()].filter((entry) => !present.has(entry.txid));

    let replacements = 0;
    let conflicts = 0;

    const run = this.store.db.transaction(() => {
      const remove = this.store.db.prepare('DELETE FROM mempool_entries WHERE txid = ?');
      for (const entry of removed) remove.run(entry.txid);

      const upsert = this.store.db.prepare(
        `INSERT INTO mempool_entries (txid, kind, first_seen, last_seen, fee_sats, vsize, summary,
                                      affected_artifacts, spent_outpoints)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT (txid) DO UPDATE SET last_seen = excluded.last_seen`,
      );
      for (const entry of added) {
        upsert.run(
          entry.txid,
          entry.kind,
          entry.firstSeen,
          entry.lastSeen,
          JSON.stringify(entry.summary),
          JSON.stringify(entry.affectedArtifacts),
          JSON.stringify(entry.spentOutpoints),
        );
      }
      const touch = this.store.db.prepare('UPDATE mempool_entries SET last_seen = ? WHERE txid = ?');
      for (const entry of existing.values()) {
        if (present.has(entry.txid)) touch.run(now, entry.txid);
      }

      // Replacement: a departed entry and an arriving entry share an input.
      const recordReplacement = this.store.db.prepare(
        `INSERT INTO mempool_replacements (replaced_txid, replacement_txid, shared_outpoint, detected_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      for (const gone of removed) {
        const goneInputs = new Set(gone.spentOutpoints);
        for (const arrival of added) {
          const shared = arrival.spentOutpoints.find((outpoint) => goneInputs.has(outpoint));
          if (shared === undefined) continue;
          const info = recordReplacement.run(gone.txid, arrival.txid, shared, now);
          if (info.changes > 0) replacements += 1;
        }
      }

      // Conflict: two entries currently in the overlay claim the same outpoint.
      const owners = new Map<string, string[]>();
      const all = [...[...existing.values()].filter((entry) => present.has(entry.txid)), ...added];
      for (const entry of all) {
        for (const outpoint of entry.spentOutpoints) {
          const bucket = owners.get(outpoint) ?? [];
          bucket.push(entry.txid);
          owners.set(outpoint, bucket);
        }
      }
      const recordConflict = this.store.db.prepare(
        `INSERT INTO mempool_conflicts (outpoint, txid_low, txid_high, detected_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      for (const [outpoint, txidsForOutpoint] of owners) {
        if (txidsForOutpoint.length < 2) continue;
        const sorted = [...new Set(txidsForOutpoint)].sort();
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const info = recordConflict.run(outpoint, sorted[i], sorted[j], now);
            if (info.changes > 0) conflicts += 1;
          }
        }
      }
    });
    run();

    return {
      scanned,
      tracked: this.count(),
      added: added.length,
      removed: removed.length,
      replacements,
      conflicts,
    };
  }

  /** Drop overlay rows for transactions that a block just confirmed. */
  confirm(txids: readonly string[]): number {
    if (txids.length === 0) return 0;
    let removed = 0;
    const run = this.store.db.transaction(() => {
      const remove = this.store.db.prepare('DELETE FROM mempool_entries WHERE txid = ?');
      for (const txid of txids) removed += remove.run(txid).changes;
    });
    run();
    return removed;
  }
}
