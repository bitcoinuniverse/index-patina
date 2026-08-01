import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { artifactId, outpointKey } from '../src/protocol.js';
import { buildLifecycleChain, type LifecycleChain } from './fixtures/chain.js';
import { createHarness, testConfig, type Harness } from './fixtures/harness.js';

let fixture: LifecycleChain;
let harness: Harness;
let idA: string;
let idB: string;
let idD: string;

before(async () => {
  const config = testConfig();
  fixture = buildLifecycleChain(config.deployment);
  harness = createHarness({ chain: fixture.chain });
  harness.indexer.open();
  const summary = await harness.indexer.syncOnce();
  assert.equal(summary.indexedHeight, fixture.heights.tip);
  assert.equal(summary.caughtUp, true);

  idA = artifactId(fixture.txids['seedA'], 0);
  idB = artifactId(fixture.txids['seedB'], 0);
  idD = artifactId(fixture.txids['seedD'], 0);
});

after(() => {
  harness.dispose();
});

describe('full lifecycle', () => {
  test('every block of the chain is stored with a state root', () => {
    const roots = harness.store.blockRoots(fixture.startHeight, fixture.heights.tip);
    assert.equal(roots.length, fixture.heights.tip - fixture.startHeight + 1);
    for (const row of roots) assert.match(row.state_root, /^[0-9a-f]{64}$/);
  });

  test('SEED creates a founding artifact with the carrier it named', () => {
    const row = harness.store.getArtifactRow(idA);
    assert.ok(row !== null);
    assert.equal(row.birth_txid, fixture.txids['seedA']);
    assert.equal(row.birth_height, fixture.heights.seedFounding);
    assert.equal(row.birth_vout, 0);
    assert.equal(row.endowment_sats, 150000);
    assert.equal(row.founding, 1);
    assert.equal(row.commit_txid, fixture.txids['commitA']);
    assert.equal(row.commit_height, fixture.heights.commits);
    assert.match(row.claimant_xonly, /^[0-9a-f]{64}$/);
    assert.match(row.salt_hex, /^[0-9a-f]{32}$/);
  });

  test('a SEED whose carrier is below the founding minimum creates nothing', () => {
    assert.equal(harness.store.getArtifactRow(artifactId(fixture.txids['seedE'], 0)), null);
    const events = harness.store.listInvalidEvents(50).filter((row) => row.txid === fixture.txids['seedE']);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'SEED_CARRIER_BELOW_MIN');
    assert.equal(events[0].height, fixture.heights.seedBelowMin);
  });

  test('the default rule bundles two artifacts onto one successor', () => {
    const carrier = harness.store.getCarrier(fixture.txids['bundle'], 0);
    assert.ok(carrier !== null);
    assert.equal(carrier.value_sats, 260000);
    assert.equal(carrier.spent_height, fixture.heights.keep);
    assert.equal(carrier.spent_txid, fixture.txids['keep']);

    const ringA = harness.store.getRings(idA)[0];
    const ringB = harness.store.getRings(idB)[0];
    assert.equal(ringA.successor_txid, fixture.txids['bundle']);
    assert.equal(ringA.successor_vout, 0);
    assert.equal(ringB.successor_txid, fixture.txids['bundle']);
    assert.equal(ringB.successor_vout, 0);
    assert.equal(ringA.start_height, fixture.heights.seedFounding);
    assert.equal(ringA.end_height, fixture.heights.bundle);
    assert.equal(ringA.depth, fixture.heights.bundle - fixture.heights.seedFounding);
  });

  test('KEEP routes the bundle to the output it names, not the default one', () => {
    const rings = harness.store.getRings(idA);
    const keepRing = rings[1];
    assert.equal(keepRing.end_height, fixture.heights.keep);
    assert.equal(keepRing.successor_txid, fixture.txids['keep']);
    assert.equal(keepRing.successor_vout, 1, 'KEEP named vout 1, the default rule would have chosen vout 0');

    const carrier = harness.store.getCarrier(fixture.txids['keep'], 1);
    assert.ok(carrier !== null);
    assert.equal(carrier.value_sats, 190000);
    assert.equal(harness.store.artifactsOnCarrier(fixture.txids['keep'], 1).length, 0, 'that carrier has since moved on');
  });

  test('the default rule steps over an OP_RETURN output', () => {
    const rings = harness.store.getRings(idA);
    const last = rings[rings.length - 1];
    assert.equal(last.successor_txid, fixture.txids['defaultRule']);
    assert.equal(last.successor_vout, 1, 'vout 0 is an OP_RETURN so the default rule chose vout 1');
  });

  test('an artifact with no eligible successor becomes a relic', () => {
    const row = harness.store.getArtifactRow(idD);
    assert.ok(row !== null);
    assert.equal(row.status, 'RELIC');
    assert.equal(row.carrier_txid, null);
    assert.equal(row.relic_height, fixture.heights.relic);
    const rings = harness.store.getRings(idD);
    assert.equal(rings.length, 1);
    assert.equal(rings[0].relic, 1);
    assert.equal(rings[0].successor_txid, null);
    assert.equal(rings[0].successor_vout, null);
    assert.equal(rings[0].end_height, fixture.heights.relic);
  });

  test('both bundled artifacts still share one live carrier', () => {
    const rowA = harness.store.getArtifactRow(idA);
    const rowB = harness.store.getArtifactRow(idB);
    assert.ok(rowA !== null && rowB !== null);
    assert.equal(rowA.status, 'ALIVE');
    assert.equal(rowB.status, 'ALIVE');
    assert.equal(rowA.carrier_txid, fixture.txids['defaultRule']);
    assert.equal(rowB.carrier_txid, fixture.txids['defaultRule']);
    assert.equal(rowA.carrier_vout, 1);
    assert.equal(rowB.carrier_vout, 1);
    const onCarrier = harness.store.artifactsOnCarrier(fixture.txids['defaultRule'], 1);
    assert.deepEqual(
      onCarrier.map((row) => row.artifact_id).sort(),
      [idA, idB].sort(),
    );
  });

  test('the in memory snapshot and the database agree', () => {
    const snapshot = harness.indexer.currentSnapshot();
    const rebuilt = harness.store.loadSnapshot();
    assert.deepEqual(rebuilt.counters, snapshot.counters);
    assert.deepEqual(Object.keys(rebuilt.artifacts).sort(), Object.keys(snapshot.artifacts).sort());
    const key = outpointKey(fixture.txids['defaultRule'], 1);
    assert.deepEqual(rebuilt.carriers[key], snapshot.carriers[key]);
  });

  test('counters match the artifacts that exist', () => {
    const counters = harness.store.counters(fixture.heights.tip);
    assert.equal(counters.artifactsAlive, 2);
    assert.equal(counters.artifactsRelic, 1);
    assert.equal(counters.foundingTotal, 3);
    assert.equal(counters.ringsTotal, 7, 'three rings each for the pair, one for the relic');
    assert.equal(counters.endowmentTotalSats, 150000 + 120000 + 110000);
    assert.equal(counters.deepestLiveDepth, fixture.heights.tip - fixture.heights.defaultRule);
  });

  test('every invalid event carries a frozen reason code', () => {
    const reasons = harness.store
      .listInvalidEvents(100)
      .map((row) => row.reason)
      .sort();
    assert.ok(reasons.includes('SEED_CARRIER_BELOW_MIN'));
    assert.ok(reasons.includes('KEEP_NO_CARRIER_INPUT'));
    assert.ok(reasons.includes('VOID_DUPLICATE_MARKER'));
  });

  test('commit reveals are recorded against the artifacts they created', () => {
    const commit = harness.store.getCommit(fixture.txids['commitA'], 0);
    assert.ok(commit !== null);
    assert.equal(commit.status, 'REVEALED');
    assert.equal(commit.reveal_txid, fixture.txids['seedA']);
    assert.equal(commit.reveal_height, fixture.heights.seedFounding);
    assert.equal(commit.artifact_id, idA);
    assert.equal(commit.height, fixture.heights.commits);

    const rejected = harness.store.getCommit(fixture.txids['commitE'], 0);
    assert.ok(rejected !== null);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.artifact_id, null);
  });

  test('protocol relevant transactions are recorded with their marker bytes', () => {
    const rows = harness.store.db
      .prepare('SELECT * FROM transactions ORDER BY block_height, block_index')
      .all() as { txid: string; kind: string; marker_op: number | null; marker_version: number | null; valid: number }[];
    const seed = rows.find((row) => row.txid === fixture.txids['seedA']);
    assert.ok(seed !== undefined);
    assert.equal(seed.kind, 'SEED');
    assert.equal(seed.marker_version, 1);
    assert.equal(seed.marker_op, 1);
    assert.equal(seed.valid, 1);

    const keep = rows.find((row) => row.txid === fixture.txids['keep']);
    assert.ok(keep !== undefined);
    assert.equal(keep.kind, 'KEEP');
    assert.equal(keep.marker_op, 2);

    const bundle = rows.find((row) => row.txid === fixture.txids['bundle']);
    assert.ok(bundle !== undefined);
    assert.equal(bundle.kind, 'CARRIER_SPEND');
    assert.equal(bundle.marker_op, null);
  });

  test('an undo document exists for every applied block', () => {
    const count = harness.store.db.prepare('SELECT COUNT(*) AS n FROM block_undo').get() as { n: number };
    const blocks = harness.store.db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number };
    assert.equal(count.n, blocks.n);
  });
});
