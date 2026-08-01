import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { apiRequest, INDEXER_VERSION } from '../src/api.js';
import { PARSER_VERSION, artifactId } from '../src/protocol.js';
import type { ApiResponse } from '../src/http.js';
import { buildLifecycleChain, makeTx, p2wpkhScript, type LifecycleChain } from './fixtures/chain.js';
import { createHarness, testConfig, type Harness } from './fixtures/harness.js';

const BASE = '/patina';

let fixture: LifecycleChain;
let harness: Harness;
let idA: string;
let idB: string;
let idD: string;

function body(response: ApiResponse): Record<string, unknown> {
  assert.equal(typeof response.body, 'object');
  return response.body as Record<string, unknown>;
}

async function get(path: string, query: Record<string, string> = {}): Promise<ApiResponse> {
  return harness.api.handle(apiRequest('GET', path, { query }));
}

async function post(path: string, payload: unknown): Promise<ApiResponse> {
  return harness.api.handle(apiRequest('POST', path, { body: payload }));
}

before(async () => {
  const config = testConfig();
  fixture = buildLifecycleChain(config.deployment);
  harness = createHarness({ chain: fixture.chain });
  harness.indexer.open();
  await harness.indexer.syncOnce();

  const pending = makeTx(
    'api-pending',
    [{ txid: fixture.txids['defaultRule'], vout: 1 }],
    [{ sats: 170000, script: p2wpkhScript('carrier-api-pending') }],
  );
  harness.rpc.setMempool([pending]);
  await harness.indexer.mempool.refresh(harness.indexer.currentSnapshot(), harness.indexer.knownTipHeight());

  idA = artifactId(fixture.txids['seedA'], 0);
  idB = artifactId(fixture.txids['seedB'], 0);
  idD = artifactId(fixture.txids['seedD'], 0);
});

after(() => harness.dispose());

describe('api contract', () => {
  test('GET /status reports the deployment, heights and counters', async () => {
    const response = await get(`${BASE}/status`);
    assert.equal(response.status, 200);
    const payload = body(response);
    assert.equal(payload['network'], 'regtest');
    assert.equal(payload['protocol_id'], 'PTNA');
    assert.match(payload['spec_sha256'] as string, /^[0-9a-f]{64}$/);
    assert.equal(payload['indexed_height'], fixture.heights.tip);
    assert.equal(payload['tip_height'], fixture.heights.tip);
    assert.equal(payload['synced'], true);
    assert.equal(payload['parser_version'], PARSER_VERSION);
    assert.equal(payload['indexer_version'], INDEXER_VERSION);
    const counters = payload['counters'] as Record<string, unknown>;
    assert.equal(counters['artifacts_alive'], 2);
    assert.equal(counters['artifacts_relic'], 1);
    assert.equal(counters['founding_total'], 3);
    assert.equal(counters['rings_total'], 7);
    assert.equal(counters['endowment_total_sats'], '380000');
    assert.equal(typeof counters['endowment_total_sats'], 'string', 'satoshis serialize as decimal strings');
  });

  test('GET /window reports the founding window against the tip', async () => {
    const response = await get(`${BASE}/window`);
    assert.equal(response.status, 200);
    const payload = body(response);
    assert.equal(payload['state'], 'OPEN');
    assert.equal(payload['h_open'], harness.config.deployment.hOpen);
    assert.equal(payload['h_close'], harness.config.deployment.hClose);
    assert.equal(payload['grace_end'], harness.config.deployment.graceEnd);
    assert.equal(payload['tip_height'], fixture.heights.tip);
    assert.equal(payload['blocks_until_open'], 0);
    assert.equal(payload['blocks_remaining'], (harness.config.deployment.hClose as number) - fixture.heights.tip);
    assert.equal(payload['founding_total'], 3);
  });

  test('GET /artifacts pages newest first and the cursor walks the whole set', async () => {
    const first = await get(`${BASE}/artifacts`, { limit: '2' });
    assert.equal(first.status, 200);
    const page = body(first);
    const items = page['items'] as Record<string, unknown>[];
    assert.equal(items.length, 2);
    assert.ok(typeof page['next_cursor'] === 'string');
    assert.ok((items[0]['birth_height'] as number) >= (items[1]['birth_height'] as number));

    const second = await get(`${BASE}/artifacts`, { limit: '2', cursor: page['next_cursor'] as string });
    const secondPage = body(second);
    const secondItems = secondPage['items'] as Record<string, unknown>[];
    assert.equal(secondItems.length, 1);
    assert.equal(secondPage['next_cursor'], null);

    const seen = [...items, ...secondItems].map((item) => item['artifact_id']);
    assert.equal(new Set(seen).size, 3);
  });

  test('GET /artifacts filters by status, founding and address', async () => {
    const alive = body(await get(`${BASE}/artifacts`, { status: 'ALIVE' }));
    assert.equal((alive['items'] as unknown[]).length, 2);

    const relic = body(await get(`${BASE}/artifacts`, { status: 'RELIC' }));
    assert.equal((relic['items'] as unknown[]).length, 1);
    assert.equal((relic['items'] as Record<string, unknown>[])[0]['artifact_id'], idD);

    const founding = body(await get(`${BASE}/artifacts`, { founding: 'true' }));
    assert.equal((founding['items'] as unknown[]).length, 3);

    const carrier = harness.store.getArtifactRow(idA);
    assert.ok(carrier?.carrier_address);
    const byAddress = body(await get(`${BASE}/artifacts`, { address: carrier.carrier_address }));
    assert.equal((byAddress['items'] as unknown[]).length, 2);

    const bad = await get(`${BASE}/artifacts`, { status: 'GONE' });
    assert.equal(bad.status, 400);
  });

  test('GET /artifacts/:id returns depth, tier and the full ring history', async () => {
    const response = await get(`${BASE}/artifacts/${idA}`);
    assert.equal(response.status, 200);
    const payload = body(response);
    assert.equal(payload['artifact_id'], idA);
    assert.equal(payload['status'], 'ALIVE');
    assert.equal(payload['founding'], true);
    assert.equal(payload['endowment_sats'], '150000');
    assert.equal(payload['depth'], fixture.heights.tip - fixture.heights.defaultRule);
    assert.equal(payload['tier'], 0);
    assert.equal(payload['tier_name'], 'Raw');
    assert.equal(payload['next_tier'], 'Sheen');
    assert.equal(payload['blocks_to_next_tier'], 1008 - (fixture.heights.tip - fixture.heights.defaultRule));
    const rings = payload['rings'] as Record<string, unknown>[];
    assert.equal(rings.length, 3);
    assert.equal(rings[0]['index'], 0);
    assert.equal(typeof rings[0]['carried_value'], 'string');
    const carrier = payload['carrier'] as Record<string, unknown>;
    assert.equal(carrier['txid'], fixture.txids['defaultRule']);
    assert.equal(carrier['vout'], 1);
    assert.equal(carrier['value'], '180000');
    assert.ok((carrier['address'] as string).startsWith('bcrt1'));

    assert.equal((await get(`${BASE}/artifacts/${'0'.repeat(64)}`)).status, 404);
    assert.equal((await get(`${BASE}/artifacts/not-an-id`)).status, 400);
  });

  test('GET /artifacts/:id/card returns a share payload', async () => {
    const response = await get(`${BASE}/artifacts/${idD}/card`);
    assert.equal(response.status, 200);
    const payload = body(response);
    assert.equal(payload['artifact_id'], idD);
    assert.equal(payload['status'], 'RELIC');
    assert.equal(payload['subtitle'], 'Firstlight Seal');
    assert.equal(payload['rings'], 1);
    assert.equal(payload['depth'], fixture.heights.relic - fixture.heights.seedRelic);
    assert.equal(payload['measured_at_height'], fixture.heights.tip);
    assert.match(payload['accent'] as string, /^hsl\(/);
  });

  test('GET /addresses/:address/holdings lists artifacts resting on that address', async () => {
    const row = harness.store.getArtifactRow(idA);
    const address = row?.carrier_address as string;
    const response = await get(`${BASE}/addresses/${address}/holdings`);
    assert.equal(response.status, 200);
    const payload = body(response);
    assert.equal(payload['address'], address);
    assert.equal(payload['count'], 2);
    assert.equal(payload['carried_value_total'], '360000');
    const ids = (payload['items'] as Record<string, unknown>[]).map((item) => item['artifact_id']).sort();
    assert.deepEqual(ids, [idA, idB].sort());

    const empty = body(await get(`${BASE}/addresses/bcrt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/holdings`));
    assert.equal(empty['count'], 0);
  });

  test('GET /carriers/:txid/:vout returns the carrier and what rests on it', async () => {
    const response = await get(`${BASE}/carriers/${fixture.txids['defaultRule']}/1`);
    assert.equal(response.status, 200);
    const payload = body(response);
    const carrier = payload['carrier'] as Record<string, unknown>;
    assert.equal(carrier['txid'], fixture.txids['defaultRule']);
    assert.equal(carrier['value'], '180000');
    assert.equal(carrier['spent_height'], null);
    assert.equal(payload['artifact_count'], 2);

    assert.equal((await get(`${BASE}/carriers/${'0'.repeat(64)}/0`)).status, 404);
    assert.equal((await get(`${BASE}/carriers/nope/0`)).status, 400);
  });

  test('GET /census/current and /census/:epoch agree', async () => {
    const current = body(await get(`${BASE}/census/current`));
    const epochZero = body(await get(`${BASE}/census/0`));
    assert.deepEqual(current, epochZero);
    assert.equal(current['epoch'], 0);
    assert.equal(current['born'], 3);
    assert.equal(current['relics'], 1);
    assert.equal(current['alive_at_end'], 2);
    assert.equal((await get(`${BASE}/census/9`)).status, 404);
  });

  test('GET /museum lists the longest completed rings first', async () => {
    const response = await get(`${BASE}/museum`, { limit: '3' });
    assert.equal(response.status, 200);
    const items = body(response)['items'] as Record<string, unknown>[];
    assert.equal(items.length, 3);
    assert.equal(items[0]['artifact_id'], idD, 'the relic held its carrier the longest');
    assert.equal(items[0]['depth'], fixture.heights.relic - fixture.heights.seedRelic);
    for (let i = 1; i < items.length; i += 1) {
      assert.ok((items[i - 1]['depth'] as number) >= (items[i]['depth'] as number));
    }
  });

  test('GET /leaderboard ranks the deepest live stretches', async () => {
    const all = body(await get(`${BASE}/leaderboard`));
    const items = all['items'] as Record<string, unknown>[];
    assert.equal(all['scope'], 'all');
    assert.equal(items.length, 2);
    assert.equal(items[0]['rank'], 1);
    assert.equal(items[0]['depth'], fixture.heights.tip - fixture.heights.defaultRule);
    assert.ok(items.every((item) => item['founding'] === true));

    const founding = body(await get(`${BASE}/leaderboard`, { scope: 'founding' }));
    assert.equal((founding['items'] as unknown[]).length, 2);
    assert.equal((await get(`${BASE}/leaderboard`, { scope: 'nonsense' })).status, 400);
  });

  test('GET /shatter lists rings newest first', async () => {
    const response = await get(`${BASE}/shatter`, { limit: '4' });
    const page = body(response);
    const items = page['items'] as Record<string, unknown>[];
    assert.equal(items.length, 4);
    assert.equal(items[0]['end_height'], fixture.heights.defaultRule);
    for (let i = 1; i < items.length; i += 1) {
      assert.ok((items[i - 1]['end_height'] as number) >= (items[i]['end_height'] as number));
    }
    const next = await get(`${BASE}/shatter`, { limit: '4', cursor: page['next_cursor'] as string });
    assert.equal((body(next)['items'] as unknown[]).length, 3);
  });

  test('GET /invalid-events returns frozen reason codes and filters by reason', async () => {
    const all = body(await get(`${BASE}/invalid-events`));
    const items = all['items'] as Record<string, unknown>[];
    assert.ok(items.length >= 3);
    assert.ok(items.every((item) => typeof item['reason'] === 'string'));

    const filtered = body(await get(`${BASE}/invalid-events`, { reason: 'SEED_CARRIER_BELOW_MIN' }));
    const filteredItems = filtered['items'] as Record<string, unknown>[];
    assert.equal(filteredItems.length, 1);
    assert.equal(filteredItems[0]['txid'], fixture.txids['seedE']);

    assert.equal((await get(`${BASE}/invalid-events`, { reason: 'NOT_A_CODE' })).status, 400);
  });

  test('GET /stats reports counters, tiers and distribution', async () => {
    const payload = body(await get(`${BASE}/stats`));
    assert.equal(payload['indexed_height'], fixture.heights.tip);
    const tiers = payload['tiers'] as Record<string, unknown>[];
    assert.equal(tiers.length, 8);
    assert.equal(tiers[0]['alive'], 2);
    const distribution = payload['distribution'] as Record<string, unknown>;
    assert.equal(distribution['live_carriers'], 1, 'the two survivors share one carrier');
    assert.equal(distribution['bundled_carriers'], 1);
    const invalid = payload['invalid_events'] as Record<string, unknown>;
    assert.ok((invalid['total'] as number) >= 3);
    assert.ok(Array.isArray(invalid['by_reason']));
    assert.equal(payload['reorgs_total'], 0);
  });

  test('GET /mempool exposes the overlay and marks it provisional', async () => {
    const response = await get(`${BASE}/mempool`);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const payload = body(response);
    assert.equal(payload['enabled'], true);
    assert.equal(payload['provisional'], true);
    const entries = payload['entries'] as Record<string, unknown>[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]['kind'], 'CARRIER_SPEND');
  });

  test('POST /safety/outpoints classifies carriers, commits and everything else', async () => {
    const liveCarrier = `${fixture.txids['defaultRule']}:1`;
    const spentCarrier = `${fixture.txids['bundle']}:0`;
    const commit = `${fixture.txids['commitA']}:0`;
    const unrelated = `${'0'.repeat(64)}:3`;

    const response = await post(`${BASE}/safety/outpoints`, {
      outpoints: [liveCarrier, spentCarrier, commit, unrelated],
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const payload = body(response);
    assert.equal(payload['stored'], false);

    const results = payload['outpoints'] as Record<string, unknown>[];
    assert.equal(results.length, 4);

    assert.equal(results[0]['kind'], 'carrier');
    assert.equal(results[0]['protected'], true);
    assert.deepEqual((results[0]['artifact_ids'] as string[]).sort(), [idA, idB].sort());
    assert.equal(results[0]['provisional_spend'], harness.indexer.mempool.entries()[0].txid);

    assert.equal(results[1]['kind'], 'carrier');
    assert.equal(results[1]['protected'], false, 'a spent carrier no longer needs protection');

    assert.equal(results[2]['kind'], 'commit');
    assert.deepEqual(results[2]['artifact_ids'], [idA]);

    assert.equal(results[3]['kind'], 'none');
    assert.equal(results[3]['protected'], false);
  });

  test('POST /safety/outpoints rejects malformed input', async () => {
    assert.equal((await post(`${BASE}/safety/outpoints`, { outpoints: 'nope' })).status, 400);
    assert.equal((await post(`${BASE}/safety/outpoints`, {})).status, 400);
    assert.equal((await post(`${BASE}/safety/outpoints`, { outpoints: ['bad'] })).status, 400);
    assert.equal(
      (await post(`${BASE}/safety/outpoints`, { outpoints: new Array(501).fill(`${'0'.repeat(64)}:0`) })).status,
      400,
    );
  });

  test('GET /health, /ready and /metrics answer at the root and under the base path', async () => {
    for (const prefix of ['', BASE]) {
      const health = await get(`${prefix}/health`);
      assert.equal(health.status, 200);
      assert.equal(body(health)['status'], 'ok');

      const ready = await get(`${prefix}/ready`);
      assert.equal(ready.status, 200);
      assert.equal(body(ready)['ready'], true);

      const metrics = await get(`${prefix}/metrics`);
      assert.equal(metrics.status, 200);
      assert.match(metrics.headers['content-type'], /text\/plain/);
      const text = metrics.body as string;
      assert.match(text, /patina_indexed_height\{network="regtest"\} 404/);
      assert.match(text, /patina_tip_lag_blocks/);
      assert.match(text, /patina_artifacts_alive\{network="regtest"\} 2/);
      assert.match(text, /patina_invalid_events_total/);
      assert.match(text, /patina_reorgs_total/);
      assert.match(text, /patina_api_request_duration_seconds_bucket/);
    }
  });

  test('GET /openapi.json documents every registered route', async () => {
    const response = await get('/openapi.json');
    assert.equal(response.status, 200);
    const document = body(response);
    assert.equal(document['openapi'], '3.1.0');
    const paths = document['paths'] as Record<string, unknown>;
    for (const path of [
      `${BASE}/status`,
      `${BASE}/window`,
      `${BASE}/artifacts`,
      `${BASE}/artifacts/{id}`,
      `${BASE}/artifacts/{id}/card`,
      `${BASE}/addresses/{address}/holdings`,
      `${BASE}/carriers/{txid}/{vout}`,
      `${BASE}/census/current`,
      `${BASE}/census/{epoch}`,
      `${BASE}/museum`,
      `${BASE}/leaderboard`,
      `${BASE}/shatter`,
      `${BASE}/invalid-events`,
      `${BASE}/stats`,
      `${BASE}/safety/outpoints`,
      `${BASE}/health`,
      `${BASE}/ready`,
      `${BASE}/metrics`,
    ]) {
      assert.ok(paths[path] !== undefined, `openapi is missing ${path}`);
    }
  });

  test('every response carries the security headers', async () => {
    const response = await get(`${BASE}/status`);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.ok(response.headers['content-security-policy'].includes("default-src 'none'"));
  });

  test('an unknown route is a 404 and a wrong method is a 405', async () => {
    assert.equal((await get(`${BASE}/nothing-here`)).status, 404);
    assert.equal((await post(`${BASE}/status`, {})).status, 405);
  });

  test('the rate limiter refuses a client that goes over its budget', async () => {
    const limited = createHarness({ chain: fixture.chain, env: { PATINA_API_RATE_LIMIT_MAX: '3' } });
    try {
      limited.indexer.open();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await limited.api.handle(apiRequest('GET', `${BASE}/status`, { clientId: 'noisy' }))).status);
      }
      assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
      assert.deepEqual(statuses.slice(3), [429, 429]);
      const health = await limited.api.handle(apiRequest('GET', '/health', { clientId: 'noisy' }));
      assert.equal(health.status, 200, 'health checks are never rate limited');
    } finally {
      limited.dispose();
    }
  });

  test('limit and cursor inputs are validated', async () => {
    assert.equal((await get(`${BASE}/artifacts`, { limit: '0' })).status, 400);
    assert.equal((await get(`${BASE}/artifacts`, { limit: 'ten' })).status, 400);
    assert.equal((await get(`${BASE}/artifacts`, { limit: '5000' })).status, 400);
    assert.equal((await get(`${BASE}/artifacts`, { cursor: 'not-a-cursor!!' })).status, 400);
  });
});
