/**
 * The census.
 *
 * One row per difficulty epoch of 2016 blocks, answering a single question:
 * of the artifacts that were alive when the epoch opened, how many were still
 * alive when it closed.
 *
 * The computation reads only heights that are already stored, so two nodes with
 * the same indexed height always produce the same table. Nothing here samples a
 * clock or reads the current tip.
 */

import { TIERS, tierFor } from './protocol.js';
import type { ArtifactRow, RingRow, Store } from './store.js';

export const EPOCH_LENGTH = 2016;

export interface CensusTierCount {
  readonly index: number;
  readonly name: string;
  readonly count: number;
}

export interface CensusRow {
  readonly epoch: number;
  readonly start_height: number;
  readonly end_height: number;
  readonly evaluated_height: number;
  readonly complete: boolean;
  readonly alive_at_start: number;
  readonly alive_at_end: number;
  readonly born: number;
  readonly relics: number;
  readonly moves: number;
  readonly survivors: number;
  readonly survival_rate: string | null;
  readonly deepest_depth: number;
  readonly endowment_alive_sats: string;
  readonly tiers: readonly CensusTierCount[];
}

export function epochOf(height: number): number {
  return Math.floor(height / EPOCH_LENGTH);
}

export function epochBounds(epoch: number): { start: number; end: number } {
  const start = epoch * EPOCH_LENGTH;
  return { start, end: start + EPOCH_LENGTH - 1 };
}

interface History {
  readonly artifact: ArtifactRow;
  readonly rings: readonly RingRow[];
}

/** True when the artifact existed and had not yet become a relic at `height`. */
export function aliveAt(history: History, height: number): boolean {
  if (history.artifact.birth_height > height) return false;
  for (const ring of history.rings) {
    if (ring.relic === 1 && ring.end_height <= height) return false;
  }
  return true;
}

/**
 * Height at which the carrier holding this artifact at `height` was created.
 * Rings cover [start_height, end_height). Anything past the last ring is held
 * by the current carrier.
 */
export function carrierHeightAt(history: History, height: number): number | null {
  if (!aliveAt(history, height)) return null;
  for (const ring of history.rings) {
    if (height < ring.end_height) return ring.start_height;
  }
  return history.artifact.carrier_height;
}

export function depthAtHeight(history: History, height: number): number | null {
  const carrierHeight = carrierHeightAt(history, height);
  if (carrierHeight === null) return null;
  const depth = height - carrierHeight;
  return depth > 0 ? depth : 0;
}

function rate(survivors: number, aliveAtStart: number): string | null {
  if (aliveAtStart === 0) return null;
  return (survivors / aliveAtStart).toFixed(4);
}

/** Compute one census row against an already indexed height. */
export function computeCensus(histories: readonly History[], epoch: number, indexedHeight: number): CensusRow {
  const { start, end } = epochBounds(epoch);
  const evaluated = Math.min(end, indexedHeight);
  const complete = indexedHeight >= end;
  const priorHeight = start - 1;

  // An epoch the chain has not reached yet has nothing to report. Saying so
  // with zeroes is honest; borrowing counts from an earlier height is not.
  if (indexedHeight < start) {
    return {
      epoch,
      start_height: start,
      end_height: end,
      evaluated_height: -1,
      complete: false,
      alive_at_start: 0,
      alive_at_end: 0,
      born: 0,
      relics: 0,
      moves: 0,
      survivors: 0,
      survival_rate: null,
      deepest_depth: 0,
      endowment_alive_sats: '0',
      tiers: TIERS.map((tier) => ({ index: tier.index, name: tier.name, count: 0 })),
    };
  }

  let aliveAtStart = 0;
  let aliveAtEnd = 0;
  let born = 0;
  let relics = 0;
  let moves = 0;
  let survivors = 0;
  let deepest = 0;
  let endowmentAlive = 0;
  const tierCounts = new Array<number>(TIERS.length).fill(0);

  for (const history of histories) {
    const wasAlive = priorHeight >= 0 && aliveAt(history, priorHeight);
    if (wasAlive) aliveAtStart += 1;

    if (history.artifact.birth_height >= start && history.artifact.birth_height <= evaluated) born += 1;

    for (const ring of history.rings) {
      if (ring.end_height < start || ring.end_height > evaluated) continue;
      if (ring.relic === 1) relics += 1;
      else moves += 1;
    }

    if (evaluated < 0 || !aliveAt(history, evaluated)) continue;
    aliveAtEnd += 1;
    if (wasAlive) survivors += 1;
    endowmentAlive += history.artifact.endowment_sats;
    const depth = depthAtHeight(history, evaluated) ?? 0;
    if (depth > deepest) deepest = depth;
    tierCounts[tierFor(depth).index] += 1;
  }

  return {
    epoch,
    start_height: start,
    end_height: end,
    evaluated_height: evaluated,
    complete,
    alive_at_start: aliveAtStart,
    alive_at_end: aliveAtEnd,
    born,
    relics,
    moves,
    survivors,
    survival_rate: rate(survivors, aliveAtStart),
    deepest_depth: deepest,
    endowment_alive_sats: String(endowmentAlive),
    tiers: TIERS.map((tier) => ({ index: tier.index, name: tier.name, count: tierCounts[tier.index] })),
  };
}

/** Read the histories once and compute the requested epoch. */
export function censusForEpoch(store: Store, epoch: number, indexedHeight: number): CensusRow {
  return computeCensus(store.allArtifactHistories(), epoch, indexedHeight);
}

/** The epoch that contains the indexed tip. */
export function currentCensus(store: Store, indexedHeight: number): CensusRow {
  const epoch = indexedHeight < 0 ? 0 : epochOf(indexedHeight);
  return censusForEpoch(store, epoch, indexedHeight);
}
