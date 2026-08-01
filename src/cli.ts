/**
 * Command line entry points.
 *
 * Each command builds the same objects the service uses at runtime, so a
 * one shot `verify` exercises the same reducer path the sync loop does.
 */

import type { Server } from 'node:http';

import { Api } from './api.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { Indexer } from './indexer.js';
import { createLogger, type Logger } from './logger.js';
import { Metrics } from './metrics.js';
import { createRpcClient, type BitcoinRpc } from './rpc.js';
import { Store } from './store.js';
import { createNodeServer } from './http.js';
import { PARSER_VERSION } from './protocol.js';

export const COMMANDS = ['sync', 'serve', 'reindex', 'reindex-range', 'verify', 'status'] as const;
export type Command = (typeof COMMANDS)[number];

export interface Runtime {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly store: Store;
  readonly rpc: BitcoinRpc;
  readonly indexer: Indexer;
}

export function buildRuntime(config: AppConfig): Runtime {
  const logger = createLogger(config.logLevel, { service: 'index-patina', network: config.network });
  const metrics = new Metrics();
  const store = new Store({ path: config.databasePath, network: config.network });
  const rpc = createRpcClient(config.rpc);
  const indexer = new Indexer({ config, store, rpc, logger, metrics });
  return { config, logger, metrics, store, rpc, indexer };
}

function parseFlags(args: readonly string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = args[i + 1];
      i += 1;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return flags;
}

export const USAGE = `index-patina <command> [options]

Commands
  sync                     Backfill history, then follow the tip. Runs until stopped.
  serve                    Serve the read API. Also syncs unless --api-only is given.
  reindex                  Drop every derived row and rebuild from the start height.
  reindex-range --from N   Roll back to N-1 and rebuild forward. Optional --to M.
  verify                   Replay every stored block and compare state roots.
  status                   Print indexed height, tip, counters and integrity.

Options
  --api-only               serve only, do not start the sync loop
  --once                   sync one pass and exit
  --from N, --to M         bounds for reindex-range
  --json                   machine readable output where a command supports it

Configuration comes from the environment. See .env.example.`;

async function commandStatus(runtime: Runtime, asJson: boolean): Promise<number> {
  const { store, indexer, config } = runtime;
  indexer.open();
  let tip = -1;
  try {
    tip = await indexer.refreshTip();
  } catch {
    tip = -1;
  }
  const indexed = store.indexedHeight();
  const counters = store.counters(indexed);
  const integrity = store.checkIntegrity();
  const payload = {
    network: config.network,
    deployment_source: config.deploymentSource,
    spec_sha256: config.deployment.specSha256,
    parser_version: PARSER_VERSION,
    database: config.databasePath,
    indexed_height: indexed,
    tip_height: tip,
    tip_lag: tip < 0 ? null : Math.max(0, tip - indexed),
    counters,
    invalid_events: store.invalidEventCount(),
    reorgs: store.reorgCount(),
    checkpoints: store.latestCheckpoint(),
    schema_tables: integrity.tables.length,
    missing_tables: integrity.missing,
    foreign_key_violations: integrity.foreignKeyViolations,
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `network            ${payload.network}`,
        `database           ${payload.database}`,
        `deployment         ${payload.deployment_source}`,
        `parser             ${payload.parser_version}`,
        `indexed height     ${payload.indexed_height}`,
        `tip height         ${payload.tip_height}`,
        `artifacts alive    ${counters.artifactsAlive}`,
        `artifacts relic    ${counters.artifactsRelic}`,
        `founding total     ${counters.foundingTotal}`,
        `rings total        ${counters.ringsTotal}`,
        `invalid events     ${payload.invalid_events}`,
        `reorgs             ${payload.reorgs}`,
        `missing tables     ${payload.missing_tables.length === 0 ? 'none' : payload.missing_tables.join(', ')}`,
        `fk violations      ${payload.foreign_key_violations}`,
        '',
      ].join('\n'),
    );
  }
  return payload.missing_tables.length === 0 && payload.foreign_key_violations === 0 ? 0 : 1;
}

async function commandSync(runtime: Runtime, once: boolean): Promise<number> {
  const { indexer, logger } = runtime;
  indexer.open();
  if (once) {
    const summary = await indexer.syncOnce();
    logger.info('sync pass complete', { ...summary });
    return 0;
  }
  installSignalHandlers(runtime, logger);
  await indexer.run();
  return 0;
}

async function commandServe(runtime: Runtime, apiOnly: boolean): Promise<number> {
  const { config, store, metrics, logger, indexer } = runtime;
  indexer.open();

  const api = new Api({
    config,
    store,
    metrics,
    logger,
    mempool: indexer.mempool,
    tipHeight: () => indexer.knownTipHeight(),
  });

  const server = createNodeServer((request) => api.handle(request));
  await new Promise<void>((done) => server.listen(config.api.port, config.api.host, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.api.port;
  logger.info('api listening', { host: config.api.host, port, basePath: config.api.basePath });

  installSignalHandlers(runtime, logger, server);

  if (!apiOnly) {
    await indexer.run();
  } else {
    await new Promise<void>(() => {});
  }
  return 0;
}

async function commandReindex(runtime: Runtime): Promise<number> {
  const { indexer, logger } = runtime;
  indexer.open();
  indexer.reindex();
  const summary = await indexer.syncOnce();
  logger.info('reindex complete', { ...summary });
  return 0;
}

async function commandReindexRange(runtime: Runtime, from: number, to: number | null): Promise<number> {
  const { indexer, logger } = runtime;
  indexer.open();
  const summary = await indexer.reindexRange(from, to);
  logger.info('reindex range complete', { from, to, ...summary });
  return 0;
}

async function commandVerify(runtime: Runtime, asJson: boolean): Promise<number> {
  const { indexer } = runtime;
  indexer.open();
  const result = await indexer.verify();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.mismatches.length === 0) {
    process.stdout.write(`verified ${result.checked} blocks, every state root matches\n`);
  } else {
    process.stdout.write(`verified ${result.checked} blocks, ${result.mismatches.length} mismatches\n`);
    for (const mismatch of result.mismatches) {
      process.stdout.write(`  height ${mismatch.height} stored ${mismatch.stored} recomputed ${mismatch.recomputed}\n`);
    }
  }
  return result.mismatches.length === 0 ? 0 : 1;
}

function installSignalHandlers(runtime: Runtime, logger: Logger, server?: Server): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown requested', { signal });
    void (async () => {
      try {
        await runtime.indexer.stop();
        if (server) await new Promise<void>((done) => server.close(() => done()));
        runtime.store.close();
        logger.info('shutdown complete');
      } catch (error) {
        logger.error('shutdown failed', { error: error as Error });
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    process.stderr.write(`unknown command ${command}\n\n${USAGE}\n`);
    return 1;
  }

  const flags = parseFlags(rest);
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const runtime = buildRuntime(config);
  try {
    switch (command as Command) {
      case 'status':
        return await commandStatus(runtime, flags['json'] === true);
      case 'sync':
        return await commandSync(runtime, flags['once'] === true);
      case 'serve':
        return await commandServe(runtime, flags['api-only'] === true);
      case 'reindex':
        return await commandReindex(runtime);
      case 'reindex-range': {
        const fromRaw = flags['from'];
        if (typeof fromRaw !== 'string' || !/^\d+$/.test(fromRaw)) {
          process.stderr.write('reindex-range needs --from N\n');
          return 2;
        }
        const toRaw = flags['to'];
        const to = typeof toRaw === 'string' && /^\d+$/.test(toRaw) ? Number.parseInt(toRaw, 10) : null;
        return await commandReindexRange(runtime, Number.parseInt(fromRaw, 10), to);
      }
      case 'verify':
        return await commandVerify(runtime, flags['json'] === true);
      default:
        return 1;
    }
  } catch (error) {
    runtime.logger.error('command failed', { command, error: error as Error });
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    if (command !== 'serve' && command !== 'sync') runtime.store.close();
  }
}
