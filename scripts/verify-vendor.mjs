#!/usr/bin/env node
/**
 * Vendored dependency integrity check.
 *
 * This indexer depends on @bitcoinuniverse/patina through a packed tarball
 * committed at vendor/bitcoinuniverse-patina-1.0.0.tgz, rather than a local
 * file: path into a sibling checkout, so the dependency resolves for anyone
 * who clones this repository on its own.
 *
 * This script recomputes the tarball's SHA-256 and compares it against the
 * hash recorded in SOURCE-PROVENANCE.json, and confirms package.json's
 * dependency line actually points at that tarball. A mismatch means the
 * vendored file was replaced, corrupted, or edited, and the build must not
 * proceed on it silently.
 *
 * Run: node scripts/verify-vendor.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROVENANCE_PATH = resolve(ROOT, 'SOURCE-PROVENANCE.json');
const PACKAGE_JSON_PATH = resolve(ROOT, 'package.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(problems) {
  process.stdout.write('vendor check FAILED\n');
  for (const p of problems) process.stdout.write(`  ${p}\n`);
  process.exitCode = 1;
}

function main() {
  const problems = [];

  const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf8'));
  const vendored = provenance?.consensusSurface?.vendoredTarball;
  if (!vendored || typeof vendored.file !== 'string' || typeof vendored.sha256 !== 'string') {
    fail([`SOURCE-PROVENANCE.json has no consensusSurface.vendoredTarball with file and sha256`]);
    return;
  }

  const tarballPath = resolve(ROOT, vendored.file);
  process.stdout.write(`vendor file        ${vendored.file}\n`);

  if (!existsSync(tarballPath)) {
    fail([`${vendored.file} does not exist. It must be committed to the repository, not gitignored.`]);
    return;
  }

  const bytes = readFileSync(tarballPath);
  const actual = sha256(bytes);
  process.stdout.write(`recorded sha256    ${vendored.sha256}\n`);
  process.stdout.write(`recomputed sha256  ${actual}\n`);

  if (actual !== vendored.sha256) {
    problems.push(
      `sha256 mismatch: vendor/${vendored.file} does not match SOURCE-PROVENANCE.json. ` +
        `The tarball was replaced or corrupted, or the provenance record is stale.`,
    );
  }

  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const depName = vendored.packageName ?? '@bitcoinuniverse/patina';
  const dep = packageJson?.dependencies?.[depName];
  const expectedDep = `file:${vendored.file}`;
  process.stdout.write(`package.json dep   ${depName}: ${dep ?? '(missing)'}\n`);

  if (dep !== expectedDep) {
    problems.push(
      `package.json dependencies["${depName}"] is ${JSON.stringify(dep ?? null)}, expected ${JSON.stringify(expectedDep)}. ` +
        `The dependency must resolve to the vendored tarball, not a local path into a sibling checkout.`,
    );
  }

  if (problems.length > 0) {
    fail(problems);
    return;
  }

  process.stdout.write('vendor check ok\n');
}

main();
