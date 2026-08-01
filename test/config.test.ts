import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, normalizeDeploymentDocument } from '../src/config.js';
import { MIN_CARRIER_FOUNDING, MIN_CARRIER_OPEN, COMMIT_MIN_AGE } from '../src/protocol.js';

const SPEC_SHA = '8bbcab8ca4890ac819104c827e8f85f850305894ccbd4e28e8a2058ec231bc4f';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'patina-config-'));
}

function writeDeployment(dir: string, document: unknown): string {
  const path = join(dir, 'deployment.json');
  writeFileSync(path, JSON.stringify(document), 'utf8');
  return path;
}

describe('configuration', () => {
  test('regtest loads the deployment record shipped with the protocol package', () => {
    const config = loadConfig({
      env: { PATINA_NETWORK: 'regtest', PATINA_RPC_OFFLINE: 'true', PATINA_DB_PATH: ':memory:' },
      cwd: process.cwd(),
    });
    assert.equal(config.network, 'regtest');
    assert.equal(config.deployment.protocolId, 'PTNA');
    assert.equal(config.deployment.minCarrierFounding, MIN_CARRIER_FOUNDING);
    assert.equal(config.deployment.minCarrierOpen, MIN_CARRIER_OPEN);
    assert.equal(config.deployment.commitMinAge, COMMIT_MIN_AGE);
    assert.equal((config.deployment.hClose as number) - (config.deployment.hOpen as number), 4032);
  });

  test('an unknown network is refused outright', () => {
    assert.throws(
      () => loadConfig({ env: { PATINA_NETWORK: 'testnet4' } }),
      (error: unknown) => error instanceof ConfigError && error.problems[0].includes('PATINA_NETWORK'),
    );
  });

  test('every problem is reported together rather than one at a time', () => {
    try {
      loadConfig({
        env: {
          PATINA_NETWORK: 'regtest',
          PATINA_RPC_OFFLINE: 'not-a-boolean',
          PATINA_API_PORT: '99999',
          PATINA_LOG_LEVEL: 'loud',
        },
      });
      assert.fail('expected the configuration to be refused');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.length >= 3, `expected several problems, got ${error.problems.length}`);
    }
  });

  test('an online client without credentials is refused', () => {
    assert.throws(
      () => loadConfig({ env: { PATINA_NETWORK: 'regtest', PATINA_RPC_OFFLINE: 'false' } }),
      (error: unknown) =>
        error instanceof ConfigError && error.problems.some((p) => p.includes('PATINA_BITCOIN_RPC_USER')),
    );
  });

  test('mainnet is refused without PATINA_MAINNET_AUTHORIZED', () => {
    const dir = tempDir();
    try {
      const path = writeDeployment(dir, {
        network: 'mainnet',
        protocol_id: 'PTNA',
        spec_sha256: SPEC_SHA,
        h_open: 900000,
        h_close: 904032,
        grace_end: 908064,
        min_carrier_founding: MIN_CARRIER_FOUNDING,
        min_carrier_open: MIN_CARRIER_OPEN,
        commit_min_age: COMMIT_MIN_AGE,
        approvers: ['Ada Reviewer', 'Grace Approver'],
      });
      assert.throws(
        () =>
          loadConfig({
            env: {
              PATINA_NETWORK: 'mainnet',
              PATINA_RPC_OFFLINE: 'true',
              PATINA_DB_PATH: ':memory:',
              PATINA_DEPLOYMENT_FILE: path,
            },
          }),
        (error: unknown) =>
          error instanceof ConfigError && error.problems.some((p) => p.includes('PATINA_MAINNET_AUTHORIZED')),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mainnet is refused when the deployment record names fewer than two approvers', () => {
    const dir = tempDir();
    try {
      const path = writeDeployment(dir, {
        network: 'mainnet',
        protocol_id: 'PTNA',
        spec_sha256: SPEC_SHA,
        h_open: 900000,
        h_close: 904032,
        grace_end: 908064,
        min_carrier_founding: MIN_CARRIER_FOUNDING,
        min_carrier_open: MIN_CARRIER_OPEN,
        commit_min_age: COMMIT_MIN_AGE,
        approvers: ['Ada Reviewer'],
      });
      assert.throws(
        () =>
          loadConfig({
            env: {
              PATINA_NETWORK: 'mainnet',
              PATINA_MAINNET_AUTHORIZED: 'true',
              PATINA_RPC_OFFLINE: 'true',
              PATINA_DB_PATH: ':memory:',
              PATINA_DEPLOYMENT_FILE: path,
            },
          }),
        (error: unknown) => error instanceof ConfigError && error.problems.some((p) => p.includes('two')),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mainnet is refused without a deployment file at all', () => {
    assert.throws(
      () =>
        loadConfig({
          env: {
            PATINA_NETWORK: 'mainnet',
            PATINA_MAINNET_AUTHORIZED: 'true',
            PATINA_RPC_OFFLINE: 'true',
            PATINA_DB_PATH: ':memory:',
          },
        }),
      (error: unknown) =>
        error instanceof ConfigError && error.problems.some((p) => p.includes('PATINA_DEPLOYMENT_FILE')),
    );
  });

  test('mainnet starts when both the authorization and two approvers are present', () => {
    const dir = tempDir();
    try {
      const path = writeDeployment(dir, {
        network: 'mainnet',
        protocol_id: 'PTNA',
        spec_sha256: SPEC_SHA,
        h_open: 900000,
        h_close: 904032,
        grace_end: 908064,
        min_carrier_founding: MIN_CARRIER_FOUNDING,
        min_carrier_open: MIN_CARRIER_OPEN,
        commit_min_age: COMMIT_MIN_AGE,
        approvers: [{ name: 'Ada Reviewer', role: 'protocol' }, { name: 'Grace Approver', role: 'operations' }],
      });
      const config = loadConfig({
        env: {
          PATINA_NETWORK: 'mainnet',
          PATINA_MAINNET_AUTHORIZED: 'true',
          PATINA_RPC_OFFLINE: 'true',
          PATINA_DB_PATH: ':memory:',
          PATINA_DEPLOYMENT_FILE: path,
        },
      });
      assert.equal(config.network, 'mainnet');
      assert.equal(config.mainnetAuthorized, true);
      assert.deepEqual(config.deployment.approvers, ['Ada Reviewer', 'Grace Approver']);
      assert.equal(config.deployment.hOpen, 900000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deployment documents are accepted in the baseline snake case form', () => {
    const normalized = normalizeDeploymentDocument({
      network: 'signet',
      protocol_id: 'PTNA',
      spec_sha256: SPEC_SHA,
      h_open: 10,
      h_close: 4042,
      grace_end: 8074,
      min_carrier_founding: 100000,
      min_carrier_open: 10000,
      commit_min_age: 144,
    }) as Record<string, unknown>;
    assert.equal(normalized['protocolId'], 'PTNA');
    assert.equal(normalized['hOpen'], 10);
    assert.equal(normalized['graceEnd'], 8074);
  });
});
