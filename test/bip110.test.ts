import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommitLeafScript,
  buildLegacyCommitLeafScript,
  buildReducedDataCommitLeafScript,
  parseCommitLeafScript,
  parseCommitLeafScriptWithMode,
  stateRoot,
} from '../src/protocol.js';
import { buildLifecycleChain } from './fixtures/chain.js';
import { createHarness, testConfig } from './fixtures/harness.js';

const CLAIMANT = '11'.repeat(32);
const COMMITMENT = '22'.repeat(32);

describe('BIP-110 commit-leaf compatibility', () => {
  test('new construction uses reduced data while both encodings remain parseable', () => {
    const legacy = buildLegacyCommitLeafScript(CLAIMANT, COMMITMENT);
    const reduced = buildReducedDataCommitLeafScript(CLAIMANT, COMMITMENT);

    assert.equal(legacy.length, 70);
    assert.equal(reduced.length, 68);
    assert.deepEqual(buildCommitLeafScript(CLAIMANT, COMMITMENT), reduced);

    assert.deepEqual(parseCommitLeafScriptWithMode(legacy), {
      claimantXOnly: CLAIMANT,
      commitment: COMMITMENT,
      mode: 'legacy envelope',
    });
    assert.deepEqual(parseCommitLeafScriptWithMode(reduced), {
      claimantXOnly: CLAIMANT,
      commitment: COMMITMENT,
      mode: 'reduced-data envelope',
    });
    assert.deepEqual(parseCommitLeafScript(legacy), parseCommitLeafScript(reduced));
  });

  test('legacy and reduced-data histories index and replay to identical IDs and roots', async () => {
    const config = testConfig();
    const reducedFixture = buildLifecycleChain(config.deployment);
    const legacyFixture = buildLifecycleChain(config.deployment, {
      commitLeafMode: 'legacy envelope',
    });
    const reduced = createHarness({ chain: reducedFixture.chain });
    const legacy = createHarness({ chain: legacyFixture.chain });

    try {
      reduced.indexer.open();
      legacy.indexer.open();
      await reduced.indexer.syncOnce();
      await legacy.indexer.syncOnce();

      const reducedSnapshot = reduced.store.loadSnapshot();
      const legacySnapshot = legacy.store.loadSnapshot();
      const reducedIds = Object.keys(reducedSnapshot.artifacts).sort();
      const legacyIds = Object.keys(legacySnapshot.artifacts).sort();

      assert.ok(reducedIds.length > 0);
      assert.deepEqual(legacyIds, reducedIds);
      assert.equal(stateRoot(legacySnapshot), stateRoot(reducedSnapshot));
      assert.deepEqual(
        legacy.store.blockRoots(legacyFixture.startHeight, legacyFixture.heights.tip),
        reduced.store.blockRoots(reducedFixture.startHeight, reducedFixture.heights.tip),
      );

      const reducedReplay = await reduced.indexer.verify();
      const legacyReplay = await legacy.indexer.verify();
      assert.deepEqual(reducedReplay.mismatches, []);
      assert.deepEqual(legacyReplay.mismatches, []);
      assert.equal(legacyReplay.checked, reducedReplay.checked);
    } finally {
      reduced.dispose();
      legacy.dispose();
    }
  });
});
