import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { aliveAt, carrierHeightAt, computeCensus, epochBounds, epochOf, EPOCH_LENGTH } from '../src/census.js';
import { artifactId } from '../src/protocol.js';
import { buildLifecycleChain, type LifecycleChain } from './fixtures/chain.js';
import { createHarness, testConfig, type Harness } from './fixtures/harness.js';

let fixture: LifecycleChain;
let harness: Harness;

before(async () => {
  const config = testConfig();
  fixture = buildLifecycleChain(config.deployment);
  harness = createHarness({ chain: fixture.chain });
  harness.indexer.open();
  await harness.indexer.syncOnce();
});

after(() => harness.dispose());

describe('census', () => {
  test('epoch arithmetic follows the 2016 block boundary', () => {
    assert.equal(EPOCH_LENGTH, 2016);
    assert.equal(epochOf(0), 0);
    assert.equal(epochOf(2015), 0);
    assert.equal(epochOf(2016), 1);
    assert.deepEqual(epochBounds(1), { start: 2016, end: 4031 });
  });

  test('the census is the same on every call', () => {
    const histories = harness.store.allArtifactHistories();
    const first = computeCensus(histories, 0, fixture.heights.tip);
    const second = computeCensus(histories, 0, fixture.heights.tip);
    assert.deepEqual(first, second);
  });

  test('the current epoch reports what the chain actually did', () => {
    const row = computeCensus(harness.store.allArtifactHistories(), 0, fixture.heights.tip);
    assert.equal(row.epoch, 0);
    assert.equal(row.evaluated_height, fixture.heights.tip);
    assert.equal(row.complete, false, 'epoch 0 ends at height 2015, well past the fixture tip');
    assert.equal(row.born, 3);
    assert.equal(row.relics, 1);
    assert.equal(row.moves, 6, 'three moves each for the two surviving artifacts');
    assert.equal(row.alive_at_end, 2);
    assert.equal(row.alive_at_start, 0, 'nothing existed before height 0');
    assert.equal(row.survival_rate, null);
    assert.equal(row.deepest_depth, fixture.heights.tip - fixture.heights.defaultRule);
    assert.equal(row.endowment_alive_sats, String(150000 + 120000));
    const total = row.tiers.reduce((sum, tier) => sum + tier.count, 0);
    assert.equal(total, row.alive_at_end);
    assert.equal(row.tiers[0].name, 'Raw');
    assert.equal(row.tiers[0].count, 2, 'a depth of twenty blocks is still Raw');
  });

  test('history reconstruction answers where an artifact was at any height', () => {
    const histories = harness.store.allArtifactHistories();
    const idA = artifactId(fixture.txids['seedA'], 0);
    const historyA = histories.find((entry) => entry.artifact.artifact_id === idA);
    assert.ok(historyA !== undefined);

    assert.equal(aliveAt(historyA, fixture.heights.seedFounding - 1), false);
    assert.equal(aliveAt(historyA, fixture.heights.seedFounding), true);
    assert.equal(carrierHeightAt(historyA, fixture.heights.seedFounding), fixture.heights.seedFounding);
    assert.equal(carrierHeightAt(historyA, fixture.heights.bundle - 1), fixture.heights.seedFounding);
    assert.equal(carrierHeightAt(historyA, fixture.heights.bundle), fixture.heights.bundle);
    assert.equal(carrierHeightAt(historyA, fixture.heights.tip), fixture.heights.defaultRule);

    const idD = artifactId(fixture.txids['seedD'], 0);
    const historyD = histories.find((entry) => entry.artifact.artifact_id === idD);
    assert.ok(historyD !== undefined);
    assert.equal(aliveAt(historyD, fixture.heights.relic - 1), true);
    assert.equal(aliveAt(historyD, fixture.heights.relic), false);
    assert.equal(carrierHeightAt(historyD, fixture.heights.relic), null);
  });

  test('an epoch the chain has not reached reports zeroes rather than stale counts', () => {
    const row = computeCensus(harness.store.allArtifactHistories(), 5, fixture.heights.tip);
    assert.equal(row.epoch, 5);
    assert.equal(row.start_height, 5 * EPOCH_LENGTH);
    assert.equal(row.evaluated_height, -1);
    assert.equal(row.alive_at_start, 0);
    assert.equal(row.alive_at_end, 0);
    assert.equal(row.born, 0);
    assert.equal(row.complete, false);
  });
});
