import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { artifactId, stateRoot } from '../src/protocol.js';
import { buildLifecycleChain, buildReorgBranch } from './fixtures/chain.js';
import { createHarness, testConfig } from './fixtures/harness.js';

describe('reorg handling', () => {
  test('a rollback restores the exact state root recorded before the block', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();

      const forkHeight = fixture.heights.bundle;
      const rootBefore = harness.store.getBlock(forkHeight)?.state_root;
      assert.ok(rootBefore !== undefined);
      const tipRootBefore = harness.store.getBlock(fixture.heights.tip)?.state_root;

      const branch = buildReorgBranch(fixture, forkHeight, 6);
      harness.rpc.reorgTo(forkHeight, branch);

      const summary = await harness.indexer.syncOnce();
      assert.ok(summary.rolledBack > 0, 'the reorg should have rolled blocks back');
      assert.equal(summary.indexedHeight, forkHeight + 6);

      // The block that survived the reorg still holds the root it was written
      // with, and the rebuilt state agrees with it.
      assert.equal(harness.store.getBlock(forkHeight)?.state_root, rootBefore);
      assert.equal(stateRoot(harness.store.loadSnapshot()), harness.store.getBlock(forkHeight + 6)?.state_root);

      // Nothing above the fork survives.
      assert.equal(harness.store.getBlock(fixture.heights.tip), null);
      assert.notEqual(harness.store.getBlock(forkHeight + 6)?.state_root, tipRootBefore);

      const reorgs = harness.store.recentReorgs(10) as { depth: number; fork_height: number; root_verified: number }[];
      assert.equal(reorgs.length, 1);
      assert.equal(reorgs[0].fork_height, forkHeight);
      assert.equal(reorgs[0].root_verified, 1);
      assert.equal(reorgs[0].depth, fixture.heights.tip - forkHeight);
    } finally {
      harness.dispose();
    }
  });

  test('state undone by a reorg is exactly the state before it', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const forkHeight = fixture.heights.bundle;
    const idA = artifactId(fixture.txids['seedA'], 0);
    const idD = artifactId(fixture.txids['seedD'], 0);

    // Index the truncated chain on its own to learn what the state at the fork
    // height looks like when nothing above it was ever applied.
    const reference = createHarness({
      chain: { chain: 'regtest', blocks: fixture.chain.blocks.filter((block) => block.height <= forkHeight) },
    });
    let referenceRoot: string;
    let referenceArtifactA: unknown;
    let referenceRings: unknown;
    try {
      reference.indexer.open();
      await reference.indexer.syncOnce();
      referenceRoot = stateRoot(reference.store.loadSnapshot());
      referenceArtifactA = reference.store.getArtifactRow(idA);
      referenceRings = reference.store.getRings(idA);
      assert.equal(reference.store.getArtifactRow(idD)?.status, 'ALIVE');
    } finally {
      reference.dispose();
    }

    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const rolled = harness.indexer.rollbackTo(forkHeight);
      assert.equal(rolled, fixture.heights.tip - forkHeight);

      assert.equal(stateRoot(harness.store.loadSnapshot()), referenceRoot);
      assert.deepEqual(harness.store.getArtifactRow(idA), referenceArtifactA);
      assert.deepEqual(harness.store.getRings(idA), referenceRings);
      assert.equal(harness.store.getArtifactRow(idD)?.status, 'ALIVE', 'the relic was undone');
      assert.equal(harness.store.getArtifactRow(idD)?.relic_height, null);

      // Rows that belonged only to rolled back blocks are gone.
      const orphanTx = harness.store.db
        .prepare('SELECT COUNT(*) AS n FROM transactions WHERE block_height > ?')
        .get(forkHeight) as { n: number };
      assert.equal(orphanTx.n, 0);
      const orphanInvalid = harness.store.db
        .prepare('SELECT COUNT(*) AS n FROM invalid_events WHERE height > ?')
        .get(forkHeight) as { n: number };
      assert.equal(orphanInvalid.n, 0);
      assert.equal(harness.store.checkIntegrity().foreignKeyViolations, 0);
    } finally {
      harness.dispose();
    }
  });

  test('rolling back to before the first SEED removes the artifact entirely', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    try {
      harness.indexer.open();
      await harness.indexer.syncOnce();
      const idA = artifactId(fixture.txids['seedA'], 0);
      assert.ok(harness.store.getArtifactRow(idA) !== null);

      harness.indexer.rollbackTo(fixture.heights.seedFounding - 1);
      assert.equal(harness.store.getArtifactRow(idA), null);
      assert.equal(harness.store.getCommit(fixture.txids['commitA'], 0), null);
      assert.equal(harness.store.counters(fixture.heights.seedFounding - 1).artifactsAlive, 0);
      assert.equal(harness.store.checkIntegrity().foreignKeyViolations, 0);
    } finally {
      harness.dispose();
    }
  });
});
