import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { createNodeServer } from '../src/http.js';
import { buildLifecycleChain } from './fixtures/chain.js';
import { createHarness, testConfig } from './fixtures/harness.js';

const run = promisify(execFile);
const CLI = resolve(process.cwd(), 'bin/index-patina.mjs');

describe('http server', () => {
  test('the node adapter serves the same handlers over a real socket', async () => {
    const config = testConfig();
    const fixture = buildLifecycleChain(config.deployment);
    const harness = createHarness({ chain: fixture.chain });
    harness.indexer.open();
    await harness.indexer.syncOnce();

    const server = createNodeServer((request) => harness.api.handle(request));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const status = await fetch(`${origin}/patina/status`);
      assert.equal(status.status, 200);
      assert.equal(status.headers.get('x-content-type-options'), 'nosniff');
      assert.match(status.headers.get('content-type') ?? '', /application\/json/);
      const payload = (await status.json()) as Record<string, unknown>;
      assert.equal(payload['indexed_height'], fixture.heights.tip);

      const metrics = await fetch(`${origin}/metrics`);
      assert.equal(metrics.status, 200);
      assert.match(await metrics.text(), /patina_indexed_height/);

      const safety = await fetch(`${origin}/patina/safety/outpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outpoints: [`${fixture.txids['defaultRule']}:1`] }),
      });
      assert.equal(safety.status, 200);
      assert.equal(safety.headers.get('cache-control'), 'no-store');
      const classified = (await safety.json()) as { outpoints: { kind: string; protected: boolean }[] };
      assert.equal(classified.outpoints[0].kind, 'carrier');
      assert.equal(classified.outpoints[0].protected, true);

      const badJson = await fetch(`${origin}/patina/safety/outpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      });
      assert.equal(badJson.status, 400);

      const missing = await fetch(`${origin}/patina/nowhere`);
      assert.equal(missing.status, 404);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      harness.dispose();
    }
  });
});

describe('command line', () => {
  test('status and verify run against a fresh database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patina-cli-'));
    try {
      const env = {
        ...process.env,
        PATINA_NETWORK: 'regtest',
        PATINA_RPC_OFFLINE: 'true',
        PATINA_DATA_DIR: dir,
        PATINA_LOG_LEVEL: 'silent',
      };
      const status = await run(process.execPath, [CLI, 'status', '--json'], { env });
      const payload = JSON.parse(status.stdout) as Record<string, unknown>;
      assert.equal(payload['network'], 'regtest');
      assert.equal(payload['indexed_height'], -1);
      assert.deepEqual(payload['missing_tables'], []);
      assert.equal(payload['foreign_key_violations'], 0);

      const verify = await run(process.execPath, [CLI, 'verify'], { env });
      assert.match(verify.stdout, /every state root matches/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mainnet without an authorization exits with the configuration code', async () => {
    await assert.rejects(
      run(process.execPath, [CLI, 'status'], {
        env: { ...process.env, PATINA_NETWORK: 'mainnet', PATINA_RPC_OFFLINE: 'true' },
      }),
      (error: unknown) => {
        const failure = error as { code: number; stderr: string };
        assert.equal(failure.code, 2);
        assert.match(failure.stderr, /PATINA_MAINNET_AUTHORIZED is not true/);
        return true;
      },
    );
  });

  test('an unknown command is refused', async () => {
    await assert.rejects(
      run(process.execPath, [CLI, 'frobnicate'], { env: { ...process.env, PATINA_RPC_OFFLINE: 'true' } }),
      (error: unknown) => {
        const failure = error as { code: number; stderr: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr, /unknown command frobnicate/);
        return true;
      },
    );
  });
});
