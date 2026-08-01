/**
 * Environment driven configuration with strict validation.
 *
 * Two rules drive the design:
 *   1. Nothing starts on a half valid configuration. Every parse problem is
 *      collected and reported together, then the process refuses to run.
 *   2. Mainnet is fail closed. It needs PATINA_MAINNET_AUTHORIZED=true and a
 *      deployment record that names at least two approvers. Missing either one
 *      is a hard stop, not a warning.
 *
 * The deployment record itself is validated by the protocol package. This file
 * only decides where the record comes from and applies the operator side of the
 * mainnet gate.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import type { LogLevel } from './logger.js';
import {
  DeploymentError,
  deploymentFor,
  loadDeployment,
  loadShippedDeployment,
  NETWORKS,
  type DeploymentRecord,
  type Network,
} from './protocol.js';

export type { DeploymentRecord, Network };
export { NETWORKS };

export interface RpcConfig {
  readonly offline: boolean;
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly cookieFile: string | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly defaultPageLimit: number;
  readonly maxPageLimit: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly corsOrigin: string | null;
  readonly publicUrl: string | null;
}

export interface IndexerConfig {
  readonly startHeight: number;
  readonly pollIntervalMs: number;
  readonly checkpointInterval: number;
  readonly undoRetentionBlocks: number;
  readonly maxReorgDepth: number;
  readonly mempoolEnabled: boolean;
  readonly mempoolPollIntervalMs: number;
}

export interface AppConfig {
  readonly network: Network;
  readonly deployment: DeploymentRecord;
  readonly deploymentSource: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly logLevel: LogLevel;
  readonly rpc: RpcConfig;
  readonly api: ApiConfig;
  readonly indexer: IndexerConfig;
  readonly mainnetAuthorized: boolean;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`configuration rejected:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export type Env = Record<string, string | undefined>;

const requireFrom = createRequire(import.meta.url);

const DEFAULT_RPC_PORT: Record<Network, number> = {
  regtest: 18443,
  signet: 38332,
  mainnet: 8332,
};

function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function readOptionalString(env: Env, key: string): string | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

function readBoolean(env: Env, key: string, fallback: boolean, problems: string[]): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  problems.push(`${key} must be true or false, received ${JSON.stringify(raw)}`);
  return fallback;
}

function readInteger(
  env: Env,
  key: string,
  fallback: number,
  problems: string[],
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    problems.push(`${key} must be an integer, received ${JSON.stringify(raw)}`);
    return fallback;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (bounds.min !== undefined && value < bounds.min) {
    problems.push(`${key} must be at least ${bounds.min}, received ${value}`);
    return fallback;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    problems.push(`${key} must be at most ${bounds.max}, received ${value}`);
    return fallback;
  }
  return value;
}

function isNetwork(value: string): value is Network {
  return (NETWORKS as readonly string[]).includes(value);
}

/**
 * Operators write deployment files with the field names used in the baseline,
 * which are snake_case. The protocol package takes camelCase. Accept both and
 * normalise before handing the document over for validation.
 */
export function normalizeDeploymentDocument(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown => (raw[camel] !== undefined ? raw[camel] : raw[snake]);
  const approversRaw = pick('approvers', 'approvers');
  const approvers = Array.isArray(approversRaw)
    ? approversRaw.map((entry) =>
        typeof entry === 'object' && entry !== null && 'name' in (entry as Record<string, unknown>)
          ? String((entry as Record<string, unknown>)['name'])
          : entry,
      )
    : approversRaw;
  return {
    network: raw['network'],
    protocolId: pick('protocolId', 'protocol_id'),
    specSha256: pick('specSha256', 'spec_sha256'),
    hOpen: pick('hOpen', 'h_open'),
    hClose: pick('hClose', 'h_close'),
    graceEnd: pick('graceEnd', 'grace_end'),
    minCarrierFounding: pick('minCarrierFounding', 'min_carrier_founding'),
    minCarrierOpen: pick('minCarrierOpen', 'min_carrier_open'),
    commitMinAge: pick('commitMinAge', 'commit_min_age'),
    ...(approvers === undefined ? {} : { approvers }),
  };
}

interface ResolvedDeployment {
  readonly record: DeploymentRecord | null;
  readonly source: string;
}

function resolveDeployment(
  env: Env,
  network: Network,
  mainnetAuthorized: boolean,
  problems: string[],
  cwd: string,
): ResolvedDeployment {
  const file = readOptionalString(env, 'PATINA_DEPLOYMENT_FILE');
  if (file) {
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    if (!existsSync(path)) {
      problems.push(`PATINA_DEPLOYMENT_FILE points at ${path} which does not exist`);
      return { record: null, source: path };
    }
    try {
      const document = normalizeDeploymentDocument(JSON.parse(readFileSync(path, 'utf8')));
      return { record: loadDeployment(document, { mainnetAuthorized }), source: path };
    } catch (error) {
      problems.push(
        error instanceof DeploymentError
          ? `deployment record at ${path} was refused: ${error.message}`
          : `deployment record at ${path} could not be read: ${(error as Error).message}`,
      );
      return { record: null, source: path };
    }
  }

  if (network === 'mainnet') {
    problems.push('mainnet refused: set PATINA_DEPLOYMENT_FILE to a reviewed and approved deployment record');
    return { record: null, source: 'unset' };
  }

  const hOpenRaw = readOptionalString(env, 'PATINA_H_OPEN');
  if (hOpenRaw !== null) {
    const specSha = readOptionalString(env, 'PATINA_SPEC_SHA256');
    if (specSha === null) {
      problems.push('PATINA_H_OPEN needs PATINA_SPEC_SHA256 so the window is bound to a specification hash');
      return { record: null, source: 'environment' };
    }
    if (!/^-?\d+$/.test(hOpenRaw)) {
      problems.push(`PATINA_H_OPEN must be an integer, received ${JSON.stringify(hOpenRaw)}`);
      return { record: null, source: 'environment' };
    }
    try {
      return {
        record: deploymentFor(network, Number.parseInt(hOpenRaw, 10), specSha),
        source: 'environment',
      };
    } catch (error) {
      problems.push(`deployment from PATINA_H_OPEN was refused: ${(error as Error).message}`);
      return { record: null, source: 'environment' };
    }
  }

  const source = `@bitcoinuniverse/patina deployments/${network}.json`;
  try {
    return { record: loadShippedDeployment(network), source };
  } catch (packageError) {
    // Fall back to reading the shipped file directly and normalising it. The
    // record is still validated by the protocol package, so this only widens
    // the field naming the file may use, never the rules it must satisfy.
    try {
      const path = join(dirname(requireFrom.resolve('@bitcoinuniverse/patina/package.json')), 'deployments', `${network}.json`);
      const document = normalizeDeploymentDocument(JSON.parse(readFileSync(path, 'utf8')));
      return { record: loadDeployment(document, { mainnetAuthorized }), source: path };
    } catch {
      problems.push(
        `no deployment record for ${network}: ${(packageError as Error).message}. Set PATINA_DEPLOYMENT_FILE, or set PATINA_H_OPEN with PATINA_SPEC_SHA256.`,
      );
      return { record: null, source: 'unset' };
    }
  }
}

export interface LoadConfigOptions {
  readonly env?: Env;
  readonly cwd?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const problems: string[] = [];

  const networkRaw = readString(env, 'PATINA_NETWORK', 'regtest');
  if (!isNetwork(networkRaw)) {
    throw new ConfigError([
      `PATINA_NETWORK must be one of ${NETWORKS.join(', ')}, received ${JSON.stringify(networkRaw)}`,
    ]);
  }
  const network: Network = networkRaw;

  const mainnetAuthorized = readBoolean(env, 'PATINA_MAINNET_AUTHORIZED', false, problems);
  if (network === 'mainnet' && !mainnetAuthorized) {
    problems.push('mainnet refused: PATINA_MAINNET_AUTHORIZED is not true');
  }

  const { record: deployment, source: deploymentSource } = resolveDeployment(
    env,
    network,
    mainnetAuthorized,
    problems,
    cwd,
  );

  // The operator side of the mainnet gate. The protocol package applies the
  // same rule to the record; this check exists so the failure is reported by
  // the process that is about to bind a port, in the operator's own terms.
  if (network === 'mainnet') {
    const approvers = (deployment?.approvers ?? []).map((name) => name.trim().toLowerCase()).filter((n) => n !== '');
    const distinct = new Set(approvers);
    if (distinct.size < 2) {
      problems.push(
        `mainnet refused: the deployment record must name at least two distinct approvers, found ${distinct.size}`,
      );
    }
    if (deployment !== null && (deployment.hOpen === null || deployment.hClose === null)) {
      problems.push('mainnet refused: the deployment record has no activation heights');
    }
  }

  const logLevelRaw = readString(env, 'PATINA_LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevelRaw)) {
    problems.push(`PATINA_LOG_LEVEL must be one of debug, info, warn, error, silent, received ${logLevelRaw}`);
  }

  const dataDirRaw = readString(env, 'PATINA_DATA_DIR', './data');
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : resolve(cwd, dataDirRaw);
  const dbRaw = readOptionalString(env, 'PATINA_DB_PATH');
  const databasePath =
    dbRaw === null
      ? join(dataDir, `patina-${network}.sqlite`)
      : dbRaw === ':memory:'
        ? ':memory:'
        : isAbsolute(dbRaw)
          ? dbRaw
          : resolve(cwd, dbRaw);

  const offline = readBoolean(env, 'PATINA_RPC_OFFLINE', false, problems);
  const rpcUrl = readString(env, 'PATINA_BITCOIN_RPC_URL', `http://127.0.0.1:${DEFAULT_RPC_PORT[network]}`);
  if (!offline) {
    try {
      const parsed = new URL(rpcUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`PATINA_BITCOIN_RPC_URL must use http or https, received ${parsed.protocol}`);
      }
    } catch {
      problems.push(`PATINA_BITCOIN_RPC_URL is not a valid URL: ${JSON.stringify(rpcUrl)}`);
    }
  }

  const cookieFileRaw = readOptionalString(env, 'PATINA_BITCOIN_RPC_COOKIE_FILE');
  const cookieFile =
    cookieFileRaw === null ? null : isAbsolute(cookieFileRaw) ? cookieFileRaw : resolve(cwd, cookieFileRaw);
  const rpcUser = readString(env, 'PATINA_BITCOIN_RPC_USER', '');
  const rpcPassword = readString(env, 'PATINA_BITCOIN_RPC_PASSWORD', '');
  if (!offline && cookieFile === null && rpcUser === '') {
    problems.push(
      'set PATINA_BITCOIN_RPC_USER and PATINA_BITCOIN_RPC_PASSWORD, or PATINA_BITCOIN_RPC_COOKIE_FILE, or run with PATINA_RPC_OFFLINE=true',
    );
  }
  if (!offline && cookieFile !== null && !existsSync(cookieFile)) {
    problems.push(`PATINA_BITCOIN_RPC_COOKIE_FILE points at ${cookieFile} which does not exist`);
  }

  const rpc: RpcConfig = {
    offline,
    url: rpcUrl,
    username: rpcUser,
    password: rpcPassword,
    cookieFile,
    timeoutMs: readInteger(env, 'PATINA_BITCOIN_RPC_TIMEOUT_MS', 30000, problems, { min: 1000, max: 600000 }),
    maxRetries: readInteger(env, 'PATINA_BITCOIN_RPC_MAX_RETRIES', 3, problems, { min: 0, max: 20 }),
  };

  const defaultPageLimit = readInteger(env, 'PATINA_API_DEFAULT_LIMIT', 50, problems, { min: 1, max: 1000 });
  const maxPageLimit = readInteger(env, 'PATINA_API_MAX_LIMIT', 200, problems, { min: 1, max: 1000 });
  if (defaultPageLimit > maxPageLimit) {
    problems.push('PATINA_API_DEFAULT_LIMIT cannot exceed PATINA_API_MAX_LIMIT');
  }

  const basePath = readString(env, 'PATINA_API_BASE_PATH', '/patina');
  if (!basePath.startsWith('/') || basePath.endsWith('/')) {
    problems.push('PATINA_API_BASE_PATH must start with / and must not end with /');
  }

  const api: ApiConfig = {
    host: readString(env, 'PATINA_API_HOST', '127.0.0.1'),
    port: readInteger(env, 'PATINA_API_PORT', 4180, problems, { min: 0, max: 65535 }),
    basePath,
    defaultPageLimit,
    maxPageLimit,
    rateLimitMax: readInteger(env, 'PATINA_API_RATE_LIMIT_MAX', 120, problems, { min: 1, max: 1000000 }),
    rateLimitWindowMs: readInteger(env, 'PATINA_API_RATE_LIMIT_WINDOW_MS', 60000, problems, {
      min: 1000,
      max: 3600000,
    }),
    corsOrigin: readOptionalString(env, 'PATINA_API_CORS_ORIGIN'),
    publicUrl: readOptionalString(env, 'PATINA_API_PUBLIC_URL'),
  };

  const startHeightDefault =
    deployment && deployment.hOpen !== null ? Math.max(0, deployment.hOpen - deployment.commitMinAge) : 0;
  const indexer: IndexerConfig = {
    startHeight: readInteger(env, 'PATINA_START_HEIGHT', startHeightDefault, problems, { min: 0 }),
    pollIntervalMs: readInteger(env, 'PATINA_POLL_INTERVAL_MS', 3000, problems, { min: 100, max: 600000 }),
    checkpointInterval: readInteger(env, 'PATINA_CHECKPOINT_INTERVAL', 2016, problems, { min: 1, max: 1000000 }),
    undoRetentionBlocks: readInteger(env, 'PATINA_UNDO_RETENTION_BLOCKS', 2016, problems, { min: 1, max: 1000000 }),
    maxReorgDepth: readInteger(env, 'PATINA_MAX_REORG_DEPTH', 200, problems, { min: 1, max: 100000 }),
    mempoolEnabled: readBoolean(env, 'PATINA_MEMPOOL_ENABLED', true, problems),
    mempoolPollIntervalMs: readInteger(env, 'PATINA_MEMPOOL_POLL_INTERVAL_MS', 5000, problems, {
      min: 500,
      max: 600000,
    }),
  };

  if (problems.length > 0 || deployment === null) {
    throw new ConfigError(problems.length > 0 ? problems : ['deployment record could not be resolved']);
  }

  return {
    network,
    deployment,
    deploymentSource,
    dataDir,
    databasePath,
    logLevel: logLevelRaw as LogLevel,
    rpc,
    api,
    indexer,
    mainnetAuthorized,
  };
}
