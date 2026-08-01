/**
 * Serialization helpers shared by every API surface.
 *
 * Two rules from the baseline drive this file:
 *   - satoshi values serialize as decimal strings
 *   - heights serialize as numbers
 *
 * Cursors are opaque to clients but are plain, stable, sortable keys inside.
 * They encode the exact tuple the SQL ORDER BY uses so a page boundary never
 * skips or repeats a row when new blocks land between requests.
 */

export function sats(value: number | bigint | null | undefined): string {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'bigint') return value.toString(10);
  if (!Number.isFinite(value)) throw new TypeError(`satoshi value is not finite: ${value}`);
  if (!Number.isSafeInteger(value)) throw new TypeError(`satoshi value is not a safe integer: ${value}`);
  return Math.trunc(value).toString(10);
}

export interface CursorParts {
  readonly primary: number;
  readonly secondary: string;
}

export function encodeCursor(parts: CursorParts): string {
  const raw = `${parts.primary}|${parts.secondary}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorParts | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const at = raw.indexOf('|');
  if (at <= 0) return null;
  const primary = Number(raw.slice(0, at));
  const secondary = raw.slice(at + 1);
  if (!Number.isInteger(primary) || primary < 0) return null;
  if (!/^[0-9a-zA-Z:_-]{0,128}$/.test(secondary)) return null;
  return { primary, secondary };
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

/**
 * Takes one row more than the caller asked for and turns the overflow into the
 * next cursor. The caller supplies the key extractor so the cursor always
 * matches the ORDER BY of the query that produced the rows.
 */
export function buildPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
  toCursor: (row: Row) => CursorParts,
): Page<Item> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const boundary = hasMore ? visible[visible.length - 1] : undefined;
  return {
    items: visible.map(toItem),
    next_cursor: boundary === undefined ? null : encodeCursor(toCursor(boundary)),
  };
}
