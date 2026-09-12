import type { Connection, Edge, PageInfo, PaginationArgs } from './types.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './types.js';

/**
 * Encode an offset into a cursor string.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString('base64');
}

/**
 * Decode a cursor string back to an offset.
 */
export function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const match = decoded.match(/^cursor:(\d+)$/);
  if (!match || !match[1]) {
    // CQ-30: Throw on invalid cursor instead of silently returning 0
    throw new Error(`Invalid cursor format: ${cursor}`);
  }
  return parseInt(match[1], 10);
}

/**
 * Resolve pagination args to offset and limit for SPI queries.
 */
export function resolvePagination(args: PaginationArgs): { offset: number; limit: number } {
  let offset = 0;
  let limit = DEFAULT_PAGE_SIZE;

  if (args.after) {
    offset = decodeCursor(args.after) + 1;
  }

  if (args.first != null) {
    limit = Math.max(0, Math.min(args.first, MAX_PAGE_SIZE));
  }

  // `last`/`before` are less common but supported for spec compliance
  if (args.before) {
    const beforeOffset = decodeCursor(args.before);
    const requestedLast = args.last ?? DEFAULT_PAGE_SIZE;
    const actualLast = Math.min(requestedLast, MAX_PAGE_SIZE);
    offset = Math.max(0, beforeOffset - actualLast);
    limit = actualLast;
  }

  return { offset, limit };
}

/**
 * Build a Relay-style connection from a list of items and pagination info.
 */
export function buildConnection<T>(
  items: T[],
  totalCount: number,
  offset: number,
): Connection<T> {
  const edges: Edge<T>[] = items.map((node, i) => ({
    node,
    cursor: encodeCursor(offset + i),
  }));

  const pageInfo: PageInfo = {
    hasNextPage: offset + items.length < totalCount,
    hasPreviousPage: offset > 0,
    startCursor: edges.length > 0 ? edges[0]!.cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
  };

  return { edges, pageInfo, totalCount };
}
