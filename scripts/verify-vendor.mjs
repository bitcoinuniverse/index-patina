#!/usr/bin/env node
/**
 * Vendored dependency integrity check.
 *
 * This indexer depends on @bitcoinuniverse/patina through a packed tarball
 * committed under vendor/, rather than a local
 * file: path into a sibling checkout, so the dependency resolves for anyone
 * who clones this repository on its own.
 *
 * This script recomputes the tarball hashes, checks the package and lockfile
 * resolutions, and reads the packed package/version/spec metadata back from
 * the archive. A mismatch means the vendored file or its provenance drifted,
 * and the build must not proceed on it silently.
 *
 * Run: node scripts/verify-vendor.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROVENANCE_PATH = resolve(ROOT, 'SOURCE-PROVENANCE.json');
const PACKAGE_JSON_PATH = resolve(ROOT, 'package.json');
const PACKAGE_LOCK_PATH = resolve(ROOT, 'package-lock.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function packedJson(bytes, wantedName) {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '');
    if (name.length === 0) break;
    const sizeText = tar.toString('ascii', offset + 124, offset + 136).replace(/\0.*$/s, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar size for ${name}`);
    const bodyOffset = offset + 512;
    if (name === wantedName) {
      return JSON.parse(tar.toString('utf8', bodyOffset, bodyOffset + size));
    }
    offset = bodyOffset + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wantedName} is missing from the vendored tarball`);
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
  const packageLock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, 'utf8'));
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

  if (provenance?.consensusSurface?.version !== vendored.packageVersion) {
    problems.push('consensusSurface.version does not match vendoredTarball.packageVersion');
  }
  if (provenance?.consensusSurface?.resolution !== expectedDep) {
    problems.push(`consensusSurface.resolution must be ${JSON.stringify(expectedDep)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(provenance?.consensusSurface?.sourceCommit ?? '')) {
    problems.push('consensusSurface.sourceCommit must pin a full lowercase Git commit');
  }
  if (!/^[0-9a-f]{64}$/.test(vendored.specSha256 ?? '')) {
    problems.push('vendoredTarball.specSha256 must pin a lowercase SHA-256 digest');
  }

  try {
    const packedManifest = packedJson(bytes, 'package/package.json');
    const packedVectors = packedJson(bytes, 'package/vectors/manifest.json');
    if (packedManifest.name !== depName) {
      problems.push(`packed package name is ${JSON.stringify(packedManifest.name)}, expected ${JSON.stringify(depName)}`);
    }
    if (packedManifest.version !== vendored.packageVersion) {
      problems.push(
        `packed package version is ${JSON.stringify(packedManifest.version)}, expected ${JSON.stringify(vendored.packageVersion)}`,
      );
    }
    if (packedVectors.specSha256 !== vendored.specSha256) {
      problems.push(
        `packed vectors specSha256 is ${JSON.stringify(packedVectors.specSha256)}, expected ${JSON.stringify(vendored.specSha256)}`,
      );
    }
  } catch (error) {
    problems.push(`could not inspect the vendored tarball: ${error instanceof Error ? error.message : String(error)}`);
  }

  const locked = packageLock?.packages?.[`node_modules/${depName}`];
  if (locked?.version !== vendored.packageVersion || locked?.resolved !== expectedDep) {
    problems.push('package-lock.json does not pin the recorded package version and vendored resolution');
  }
  const expectedIntegrity = sha512Integrity(bytes);
  if (locked?.integrity !== expectedIntegrity) {
    problems.push('package-lock.json integrity does not match the vendored tarball bytes');
  }

  if (problems.length > 0) {
    fail(problems);
    return;
  }

  process.stdout.write('vendor check ok\n');
}

main();
