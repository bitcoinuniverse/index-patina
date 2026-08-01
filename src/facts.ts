/**
 * Storable facts derived from a block.
 *
 * The reducer decides what the state is. This module only reads the same block
 * back through the protocol package to recover the details the state model does
 * not carry but an operator API needs: which output held the marker, which
 * input revealed the commit leaf, which claimant key and salt were used, and
 * which output scripts back the carriers.
 *
 * Every judgement here comes from a protocol package call. Nothing restates a
 * rule.
 */

import {
  artifactId as deriveArtifactId,
  commitCommitment,
  decodeMarker,
  findCommitInputs,
  outpointKey,
  scanScriptPubKey,
  validateSeed,
  type BlockView,
  type DeploymentRecord,
  type InvalidEvent,
  type Marker,
  type PatinaEvent,
  type SeedMarker,
  type Snapshot,
  type TxView,
} from './protocol.js';

export type TxKind = 'SEED' | 'KEEP' | 'CARRIER_SPEND' | 'MARKER_ONLY';

export interface TxFact {
  readonly txid: string;
  readonly txIndex: number;
  readonly kind: TxKind;
  readonly markerVersion: number | null;
  readonly markerOp: number | null;
  readonly markerVout: number | null;
  readonly markerPayloadHex: string | null;
  readonly valid: boolean;
}

export interface SeedFact {
  readonly txid: string;
  readonly artifactId: string;
  readonly carrierVout: number;
  readonly claimantXOnly: string;
  readonly saltHex: string;
  readonly commitTxid: string;
  readonly commitVout: number;
  readonly commitHeight: number;
}

export interface CommitRevealFact {
  readonly txid: string;
  readonly vout: number;
  readonly height: number;
  readonly valueSats: number;
  readonly commitment: string;
  readonly claimantXOnly: string;
  readonly revealTxid: string;
  readonly revealHeight: number;
  readonly status: 'REVEALED' | 'REJECTED';
  readonly artifactId: string | null;
}

export interface BlockFacts {
  readonly txs: readonly TxFact[];
  readonly seeds: ReadonlyMap<string, SeedFact>;
  readonly commits: readonly CommitRevealFact[];
  /** Output scripts of this block, keyed by outpoint, for carrier rows. */
  readonly outputScripts: ReadonlyMap<string, string>;
}

interface MarkerSlot {
  readonly candidates: number[];
  readonly vout: number | null;
  readonly payloadHex: string | null;
  readonly marker: Marker | null;
}

function readMarkerSlot(tx: TxView): MarkerSlot {
  const candidates: number[] = [];
  let payload: Buffer | null = null;
  for (let i = 0; i < tx.outputs.length; i += 1) {
    const scan = scanScriptPubKey(tx.outputs[i].scriptPubKey);
    if (!scan.marker) continue;
    candidates.push(i);
    if (candidates.length === 1 && scan.ok) payload = scan.payload;
  }
  if (candidates.length === 0) return { candidates, vout: null, payloadHex: null, marker: null };
  const vout = candidates[0];
  if (candidates.length > 1 || payload === null) {
    return { candidates, vout, payloadHex: payload === null ? null : payload.toString('hex'), marker: null };
  }
  const decoded = decodeMarker(payload);
  return {
    candidates,
    vout,
    payloadHex: payload.toString('hex'),
    marker: decoded.ok ? decoded.marker : null,
  };
}

function markerBytes(payloadHex: string | null): { version: number | null; op: number | null } {
  if (payloadHex === null || payloadHex.length < 12) return { version: null, op: null };
  return {
    version: Number.parseInt(payloadHex.slice(8, 10), 16),
    op: Number.parseInt(payloadHex.slice(10, 12), 16),
  };
}

/**
 * Derive every storable fact of one block.
 * `prior` is the snapshot before the block, which is what decides whether an
 * input spent a live carrier.
 */
export function deriveBlockFacts(
  view: BlockView,
  prior: Snapshot,
  events: readonly PatinaEvent[],
  invalidEvents: readonly InvalidEvent[],
  deployment: DeploymentRecord,
): BlockFacts {
  const invalidByTxid = new Set(invalidEvents.map((event) => event.txid));
  const createdByTxid = new Map<string, PatinaEvent[]>();
  for (const event of events) {
    if (event.kind !== 'CREATED') continue;
    const bucket = createdByTxid.get(event.txid) ?? [];
    bucket.push(event);
    createdByTxid.set(event.txid, bucket);
  }

  const txs: TxFact[] = [];
  const seeds = new Map<string, SeedFact>();
  const commits: CommitRevealFact[] = [];
  const outputScripts = new Map<string, string>();

  for (let txIndex = 0; txIndex < view.txs.length; txIndex += 1) {
    const tx = view.txs[txIndex];
    for (let vout = 0; vout < tx.outputs.length; vout += 1) {
      outputScripts.set(outpointKey(tx.txid, vout), tx.outputs[vout].scriptPubKey);
    }
    if (tx.coinbase === true) continue;

    const slot = readMarkerSlot(tx);
    const spendsCarrier = tx.inputs.some((input) => {
      const ids = prior.carriers[outpointKey(input.txid, input.vout)];
      return ids !== undefined && ids.length > 0;
    });

    let kind: TxKind | null = null;
    if (slot.marker !== null) kind = slot.marker.op === 'SEED' ? 'SEED' : 'KEEP';
    else if (slot.candidates.length > 0) kind = 'MARKER_ONLY';
    else if (spendsCarrier) kind = 'CARRIER_SPEND';
    if (kind === null) continue;

    const bytes = markerBytes(slot.payloadHex);
    txs.push({
      txid: tx.txid,
      txIndex,
      kind,
      markerVersion: bytes.version,
      markerOp: bytes.op,
      markerVout: slot.vout,
      markerPayloadHex: slot.payloadHex,
      valid: !invalidByTxid.has(tx.txid),
    });

    if (slot.marker === null || slot.marker.op !== 'SEED') continue;

    const seedMarker = slot.marker as SeedMarker;
    const result = validateSeed(tx, seedMarker, view.height, deployment);
    if (result.ok) {
      const commitInput = tx.inputs[result.commitInputIndex];
      const id = deriveArtifactId(tx.txid, result.carrierVout);
      // Only record a SEED fact when the reducer actually created this artifact.
      const created = (createdByTxid.get(tx.txid) ?? []).some((event) => event.artifactId === id);
      if (created) {
        seeds.set(id, {
          txid: tx.txid,
          artifactId: id,
          carrierVout: result.carrierVout,
          claimantXOnly: result.claimantXOnly,
          saltHex: seedMarker.salt,
          commitTxid: commitInput.txid,
          commitVout: commitInput.vout,
          commitHeight: result.commitHeight,
        });
        commits.push({
          txid: commitInput.txid,
          vout: commitInput.vout,
          height: result.commitHeight,
          valueSats: commitInput.prevout.value,
          commitment: commitCommitment(result.claimantXOnly, seedMarker.salt).toString('hex'),
          claimantXOnly: result.claimantXOnly,
          revealTxid: tx.txid,
          revealHeight: view.height,
          status: 'REVEALED',
          artifactId: id,
        });
        continue;
      }
    }

    // A SEED that failed still tells an operator that a commit output was
    // burned. Record every commit leaf the transaction revealed.
    for (const candidate of findCommitInputs(tx)) {
      const input = tx.inputs[candidate.inputIndex];
      commits.push({
        txid: input.txid,
        vout: input.vout,
        height: candidate.height,
        valueSats: input.prevout.value,
        commitment: candidate.commitment,
        claimantXOnly: candidate.claimantXOnly,
        revealTxid: tx.txid,
        revealHeight: view.height,
        status: 'REJECTED',
        artifactId: null,
      });
    }
  }

  return { txs, seeds, commits, outputScripts };
}

/** Map every outpoint this block spent to the transaction that spent it. */
export function spendersOf(view: BlockView): Map<string, string> {
  const map = new Map<string, string>();
  for (const tx of view.txs) {
    if (tx.coinbase === true) continue;
    for (const input of tx.inputs) map.set(outpointKey(input.txid, input.vout), tx.txid);
  }
  return map;
}
