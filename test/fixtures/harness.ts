/**
 * Test harness.
 *
 * Builds the same objects the service builds at runtime, with the offline RPC
 * client in front of a synthetic chain. Nothing between the RPC boundary and
 * the database is replaced.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Api } from '../../src/api.js';
import { loadConfig, type AppConfig, type Env } from '../../src/config.js';
import { Indexer } from '../../src/indexer.js';
import { createLogger } from '../../src/logger.js';
import { Metrics } from '../../src/metrics.js';
import { OfflineRpcClient, type OfflineChain } from '../../src/rpc.js';
import { Store } from '../../src/store.js';
import { Resolver } from '../../src/resolver.js';

export interface Harness {
  readonly config: AppConfig;
  readonly store: Store;
  readonly rpc: OfflineRpcClient;
  readonly indexer: Indexer;
  readonly metrics: Metrics;
  readonly api: Api;
  readonly dbPath: string;
  dispose(): void;
}

export function testEnv(overrides: Env = {}): Env {
  return {
    PATINA_NETWORK: 'regtest',
    PATINA_RPC_OFFLINE: 'true',
    PATINA_DB_PATH: ':memory:',
    PATINA_LOG_LEVEL: 'silent',
    PATINA_START_HEIGHT: '190',
    PATINA_MEMPOOL_ENABLED: 'true',
    PATINA_API_RATE_LIMIT_MAX: '100000',
    ...overrides,
  };
}

export function testConfig(overrides: Env = {}): AppConfig {
  return loadConfig({ env: testEnv(overrides), cwd: process.cwd() });
}

export interface HarnessOptions {
  readonly chain?: OfflineChain;
  readonly onDisk?: boolean;
  readonly env?: Env;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  let dir: string | null = null;
  let dbPath = ':memory:';
  if (options.onDisk === true) {
    dir = mkdtempSync(join(tmpdir(), 'patina-test-'));
    dbPath = join(dir, 'patina.sqlite');
  }
  const config = testConfig({ ...options.env, PATINA_DB_PATH: dbPath });
  const logger = createLogger('silent');
  const metrics = new Metrics();
  const store = new Store({ path: config.databasePath, network: config.network });
  const rpc = new OfflineRpcClient(options.chain ?? { chain: 'regtest', blocks: [] });
  const resolver = new Resolver(rpc, { onRpcCall: (failed) => metrics.recordRpcCall(failed) });
  const indexer = new Indexer({ config, store, rpc, logger, metrics, resolver });
  const api = new Api({
    config,
    store,
    metrics,
    logger,
    mempool: indexer.mempool,
    tipHeight: () => indexer.knownTipHeight(),
  });

  return {
    config,
    store,
    rpc,
    indexer,
    metrics,
    api,
    dbPath,
    dispose(): void {
      try {
        store.close();
      } catch {
        // already closed
      }
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Reopen a database that is already on disk, as a restart would. */
export function reopen(harness: Harness): Harness {
  harness.store.close();
  const config = harness.config;
  const logger = createLogger('silent');
  const metrics = new Metrics();
  const store = new Store({ path: config.databasePath, network: config.network });
  const rpc = harness.rpc;
  const resolver = new Resolver(rpc, { onRpcCall: (failed) => metrics.recordRpcCall(failed) });
  const indexer = new Indexer({ config, store, rpc, logger, metrics, resolver });
  const api = new Api({
    config,
    store,
    metrics,
    logger,
    mempool: indexer.mempool,
    tipHeight: () => indexer.knownTipHeight(),
  });
  return {
    ...harness,
    store,
    indexer,
    metrics,
    api,
    dispose(): void {
      try {
        store.close();
      } catch {
        // already closed
      }
      harness.dispose();
    },
  };
}
