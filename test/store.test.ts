import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EXPECTED_TABLES, MIGRATIONS } from '../src/migrations.js';
import { Store, StoreError } from '../src/store.js';
import { scriptToAddress } from '../src/address.js';
import { PARSER_VERSION } from '../src/protocol.js';
import { p2wpkhScript, p2trScript, label } from './fixtures/chain.js';

const SPEC_SHA = '8bbcab8ca4890ac819104c827e8f85f850305894ccbd4e28e8a2058ec231bc4f';

function freshStore(): Store {
  const store = new Store({ path: ':memory:', network: 'regtest' });
  store.migrate();
  return store;
}

describe('store migrations', () => {
  test('one migration run creates every expected table', () => {
    const store = freshStore();
    try {
      const integrity = store.checkIntegrity();
      assert.deepEqual(integrity.missing, []);
      assert.equal(integrity.foreignKeyViolations, 0);
      for (const table of EXPECTED_TABLES) assert.ok(integrity.tables.includes(table), `missing ${table}`);
    } finally {
      store.close();
    }
  });

  test('migrating twice applies nothing the second time', () => {
    const store = new Store({ path: ':memory:', network: 'regtest' });
    try {
      assert.equal(store.migrate(), MIGRATIONS.length);
      assert.equal(store.migrate(), 0);
    } finally {
      store.close();
    }
  });

  test('foreign keys and check constraints are enforced', () => {
    const store = freshStore();
    try {
      assert.throws(() =>
        store.db
          .prepare(
            `INSERT INTO rings (artifact_id, ring_index, start_height, end_height, depth, carried_value_sats,
                                successor_txid, successor_vout, relic)
             VALUES (?, 0, 1, 2, 1, 100, NULL, NULL, 0)`,
          )
          .run('f'.repeat(64)),
      );

      assert.throws(() =>
        store.db
          .prepare(
            `INSERT INTO blocks (height, hash, previous_hash, block_time, tx_count, parser_version,
                                 state_root, prior_state_root, event_count, applied_at)
             VALUES (-1, ?, NULL, 0, 0, 'x', 'y', 'z', 0, 0)`,
          )
          .run('a'.repeat(64)),
      );
    } finally {
      store.close();
    }
  });

  test('a database is bound to one network, parser and specification', () => {
    const store = freshStore();
    try {
      store.bind(PARSER_VERSION, SPEC_SHA, 0);
      store.bind(PARSER_VERSION, SPEC_SHA, 0);
      assert.throws(() => store.bind('patina/9.9.9', SPEC_SHA, 0), StoreError);
      assert.throws(() => store.bind(PARSER_VERSION, 'a'.repeat(64), 0), StoreError);
    } finally {
      store.close();
    }
  });

  test('an empty store reports height -1 and an empty snapshot', () => {
    const store = freshStore();
    try {
      assert.equal(store.indexedHeight(), -1);
      const snapshot = store.loadSnapshot();
      assert.equal(snapshot.height, -1);
      assert.deepEqual(snapshot.artifacts, {});
      assert.equal(snapshot.counters.artifactsAlive, 0);
    } finally {
      store.close();
    }
  });
});

describe('address rendering', () => {
  test('segwit version zero programs render as bech32', () => {
    const address = scriptToAddress(p2wpkhScript('carrier'), 'regtest');
    assert.ok(address !== null);
    assert.ok(address.startsWith('bcrt1q'), `unexpected address ${address}`);
    assert.equal(scriptToAddress(p2wpkhScript('carrier'), 'mainnet')?.startsWith('bc1q'), true);
  });

  test('taproot programs render as bech32m', () => {
    const address = scriptToAddress(p2trScript(label('key/A')), 'regtest');
    assert.ok(address !== null && address.startsWith('bcrt1p'), `unexpected address ${address}`);
  });

  test('a bare OP_RETURN has no address', () => {
    assert.equal(scriptToAddress('6a0a00112233445566778899', 'regtest'), null);
  });

  test('P2PKH and P2SH render as base58', () => {
    const hash = '00'.repeat(20);
    assert.equal(scriptToAddress(`76a914${hash}88ac`, 'mainnet'), '1111111111111111111114oLvT2');
    const p2sh = scriptToAddress(`a914${hash}87`, 'mainnet');
    assert.ok(p2sh !== null && p2sh.startsWith('3'), `unexpected address ${p2sh}`);
  });
});
