/**
 * Regression tests for cursor encoding/decoding.
 *
 * Root cause: The search resolver used raw parseInt(base64) instead of
 * decodeCursor(), which:
 * 1. Accepted any base64-encoded number (no format validation)
 * 2. Missed the +1 offset adjustment (off-by-one)
 * 3. Silently returned offset=0 on invalid cursors
 *
 * Fixed in: resolver-generator.ts search resolver now uses decodeCursor().
 */
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../graphql/pagination.js';

describe('cursor encoding/decoding', () => {
  it('round-trips correctly', () => {
    const cursor = encodeCursor(42);
    expect(decodeCursor(cursor)).toBe(42);
  });

  it('encodes with cursor: prefix', () => {
    const cursor = encodeCursor(0);
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    expect(decoded).toBe('cursor:0');
  });

  it('rejects raw base64-encoded numbers (the old bug)', () => {
    // Old code accepted this — just a bare number in base64
    const fakeCursor = Buffer.from('42').toString('base64');
    expect(() => decodeCursor(fakeCursor)).toThrow('Invalid cursor format');
  });

  it('rejects empty string', () => {
    expect(() => decodeCursor('')).toThrow('Invalid cursor format');
  });

  it('rejects arbitrary base64', () => {
    const bad = Buffer.from('not-a-cursor').toString('base64');
    expect(() => decodeCursor(bad)).toThrow('Invalid cursor format');
  });

  it('rejects cursor with wrong prefix', () => {
    const bad = Buffer.from('offset:5').toString('base64');
    expect(() => decodeCursor(bad)).toThrow('Invalid cursor format');
  });

  it('handles large offsets', () => {
    const cursor = encodeCursor(999999);
    expect(decodeCursor(cursor)).toBe(999999);
  });
});
