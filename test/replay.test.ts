import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stateRoot } from '../src/protocol.js';
import { buildLifecycleChain } from './fixtures/chain.js';
import { createHarness, reopen, testConfig } from './fixtures/harness.js';

describe('deterministic replay', () => {
  test('re-applying an already stored block is a no operation', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const before = stateRoot(harness.store.loadSnapshot());
      const blockCount = harness.store.db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number };

      const raw = fixture.chain.blocks.find((block) => block.height === fixture.heights.keep);
      assert.ok(raw !== undefined);
      const view = await harness.indexer.resolver.resolveRawBlock(raw);
      harness.indexer.applyResolvedBlock(view, raw.time);

      assert.equal(stateRoot(harness.store.loadSnapshot()), before);
      assert.deepEqual(harness.store.db.prepare('SELECT COUNT(*) AS n FROM blocks').get(), blockCount);
    } finally {
      harness.dispose();
    }
  });

  test('a second sync pass applies nothing new', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      const first = await harness.indexer.syncOnce();
      const second = await harness.indexer.syncOnce();
      assert.ok(first.applied > 0);
      assert.equal(second.applied, 0);
      assert.equal(second.rolledBack, 0);
      assert.equal(second.indexedHeight, first.indexedHeight);
    } finally {
      harness.dispose();
    }
  });

  test('a restart rebuilds the snapshot from the database and continues', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const partial = fixture.chain.blocks.filter((block) => block.height <= fixture.heights.keep);
    let harness = createHarness({ chain: { chain: 'regtest', blocks: partial }, onDisk: true });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const rootAtKeep = stateRoot(harness.store.loadSnapshot());
      assert.equal(harness.store.indexedHeight(), fixture.heights.keep);

      harness = reopen(harness);
      harness.indexer.open();
      assert.equal(stateRoot(harness.indexer.currentSnapshot()), rootAtKeep);

      harness.rpc.setChain(fixture.chain);
      const summary = await harness.indexer.syncOnce();
      assert.equal(summary.indexedHeight, fixture.heights.tip);
      assert.equal(summary.rolledBack, 0);
    } finally {
      harness.dispose();
    }
  });

  test('reindex reproduces the identical root for every height', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const before = harness.store.blockRoots(fixture.startHeight, fixture.heights.tip);
      assert.ok(before.length > 0);

      harness.indexer.reindex();
      assert.equal(harness.store.indexedHeight(), -1);
      await harness.indexer.syncOnce();

      const after = harness.store.blockRoots(fixture.startHeight, fixture.heights.tip);
      assert.deepEqual(after, before);
    } finally {
      harness.dispose();
    }
  });

  test('reindex-range rebuilds a window and lands on the same roots', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const before = harness.store.blockRoots(fixture.startHeight, fixture.heights.tip);

      await harness.indexer.reindexRange(fixture.heights.bundle, null);
      const after = harness.store.blockRoots(fixture.startHeight, fixture.heights.tip);
      assert.deepEqual(after, before);
    } finally {
      harness.dispose();
    }
  });

  test('verify replays every stored block and finds no mismatch', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const result = await harness.indexer.verify();
      assert.equal(result.checked, fixture.heights.tip - fixture.startHeight + 1);
      assert.deepEqual(result.mismatches, []);
    } finally {
      harness.dispose();
    }
  });

  test('checkpoints are written on the configured interval', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain, env: { PATINA_CHECKPOINT_INTERVAL: '50' } });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const checkpoints = harness.store.db.prepare('SELECT * FROM checkpoints ORDER BY height').all() as {
        height: number;
        state_root: string;
      }[];
      assert.ok(checkpoints.length >= 4, `expected several checkpoints, got ${checkpoints.length}`);
      for (const checkpoint of checkpoints) {
        assert.equal(checkpoint.height % 50, 0);
        assert.equal(checkpoint.state_root, harness.store.getBlock(checkpoint.height)?.state_root);
      }
      const latest = harness.store.latestCheckpoint();
      assert.ok(latest !== null && latest.height === checkpoints[checkpoints.length - 1].height);
    } finally {
      harness.dispose();
    }
  });
});
