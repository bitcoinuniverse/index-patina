/**
 * The version of this service, read from its own package manifest.
 *
 * The lookup walks up from this module rather than using a fixed relative path,
 * because the same source runs from `src` during a typecheck and from
 * `dist/src` after a build, and the two sit at different depths.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@bitcoinuniverse/index-patina';

function findVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // No manifest at this level, or not ours. Keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the ${PACKAGE_NAME} package manifest from ${import.meta.url}`);
}

export const INDEXER_VERSION: string = findVersion();
