import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stateRoot } from '../src/protocol.js';
import { buildLifecycleChain, makeTx, p2wpkhScript, opReturnDataScript } from './fixtures/chain.js';
import { createHarness, testConfig } from './fixtures/harness.js';

async function syncedHarness() {
  const config = testConfig();
  const fixture = buildLifecycleChain(config.deployment);
  const harness = createHarness({ chain: fixture.chain });
  harness.indexer.open();
  await harness.indexer.syncOnce();
  return { harness, fixture };
}

describe('mempool overlay', () => {
  test('an unconfirmed carrier spend is tracked without touching canonical state', async () => {
    const { harness, fixture } = await syncedHarness();
    try {
      const canonicalRootBefore = stateRoot(harness.store.loadSnapshot());
      const artifactsBefore = harness.store.db.prepare('SELECT * FROM artifacts ORDER BY artifact_id').all();
      const carriersBefore = harness.store.db.prepare('SELECT * FROM carriers ORDER BY txid, vout').all();

      const pending = makeTx(
        'pending-move',
        [{ txid: fixture.txids['defaultRule'], vout: 1 }],
        [{ sats: 170000, script: p2wpkhScript('carrier-pending') }],
      );
      harness.rpc.setMempool([pending]);

      const result = await harness.indexer.mempool.refresh(
        harness.indexer.currentSnapshot(),
        harness.indexer.knownTipHeight(),
      );
      assert.equal(result.added, 1);
      assert.equal(result.tracked, 1);

      const entries = harness.indexer.mempool.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].txid, pending.txid);
      assert.equal(entries[0].kind, 'CARRIER_SPEND');
      assert.equal(entries[0].affectedArtifacts.length, 2, 'both bundled artifacts are affected');

      assert.equal(stateRoot(harness.store.loadSnapshot()), canonicalRootBefore);
      assert.deepEqual(harness.store.db.prepare('SELECT * FROM artifacts ORDER BY artifact_id').all(), artifactsBefore);
      assert.deepEqual(harness.store.db.prepare('SELECT * FROM carriers ORDER BY txid, vout').all(), carriersBefore);
    } finally {
      harness.dispose();
    }
  });

  test('a replacement sharing an input is recorded as a replacement', async () => {
    const { harness, fixture } = await syncedHarness();
    try {
      const first = makeTx(
        'rbf-first',
        [{ txid: fixture.txids['defaultRule'], vout: 1 }],
        [{ sats: 175000, script: p2wpkhScript('carrier-rbf-one') }],
      );
      harness.rpc.setMempool([first]);
      await harness.indexer.mempool.refresh(harness.indexer.currentSnapshot(), harness.indexer.knownTipHeight());

      const second = makeTx(
        'rbf-second',
        [{ txid: fixture.txids['defaultRule'], vout: 1 }],
        [{ sats: 160000, script: p2wpkhScript('carrier-rbf-two') }],
      );
      harness.rpc.setMempool([second]);
      const result = await harness.indexer.mempool.refresh(
        harness.indexer.currentSnapshot(),
        harness.indexer.knownTipHeight(),
      );

      assert.equal(result.removed, 1);
      assert.equal(result.added, 1);
      assert.equal(result.replacements, 1);
      const rows = harness.indexer.mempool.replacements() as {
        replaced_txid: string;
        replacement_txid: string;
        shared_outpoint: string;
      }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].replaced_txid, first.txid);
      assert.equal(rows[0].replacement_txid, second.txid);
      assert.equal(rows[0].shared_outpoint, `${fixture.txids['defaultRule']}:1`);
      assert.equal(harness.indexer.mempool.count(), 1);
    } finally {
      harness.dispose();
    }
  });

  test('two unconfirmed transactions claiming one outpoint are recorded as a conflict', async () => {
    const { harness, fixture } = await syncedHarness();
    try {
      const left = makeTx(
        'conflict-left',
        [{ txid: fixture.txids['defaultRule'], vout: 1 }],
        [{ sats: 170000, script: p2wpkhScript('carrier-left') }],
      );
      const right = makeTx(
        'conflict-right',
        [{ txid: fixture.txids['defaultRule'], vout: 1 }],
        [{ sats: 165000, script: p2wpkhScript('carrier-right') }],
      );
      harness.rpc.setMempool([left, right]);
      const result = await harness.indexer.mempool.refresh(
        harness.indexer.currentSnapshot(),
        harness.indexer.knownTipHeight(),
      );
      assert.equal(result.added, 2);
      assert.equal(result.conflicts, 1);
      const rows = harness.indexer.mempool.conflicts() as { outpoint: string; txid_low: string; txid_high: string }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outpoint, `${fixture.txids['defaultRule']}:1`);
      assert.ok(rows[0].txid_low < rows[0].txid_high);
    } finally {
      harness.dispose();
    }
  });

  test('a transaction with no protocol role is not tracked', async () => {
    const { harness } = await syncedHarness();
    try {
      const noise = makeTx(
        'noise',
        [{ txid: 'a'.repeat(64), vout: 0 }],
        [{ sats: 1000, script: opReturnDataScript('noise') }],
      );
      harness.rpc.setMempool([noise]);
      const result = await harness.indexer.mempool.refresh(
        harness.indexer.currentSnapshot(),
        harness.indexer.knownTipHeight(),
      );
      assert.equal(result.tracked, 0);
      assert.equal(harness.indexer.mempool.entries().length, 0);
    } finally {
      harness.dispose();
    }
  });

  test('confirming a transaction drops it from the overlay', async () => {
    const { harness, fixture } = await syncedHarness();
    try {
      const pending = makeTx(
        'pending-confirm',
        [{ txid: fixture.txids['defaultRule'], vout: 1 }],
        [{ sats: 170000, script: p2wpkhScript('carrier-confirm') }],
      );
      harness.rpc.setMempool([pending]);
      await harness.indexer.mempool.refresh(harness.indexer.currentSnapshot(), harness.indexer.knownTipHeight());
      assert.equal(harness.indexer.mempool.count(), 1);
      assert.equal(harness.indexer.mempool.confirm([pending.txid]), 1);
      assert.equal(harness.indexer.mempool.count(), 0);
    } finally {
      harness.dispose();
    }
  });
});
