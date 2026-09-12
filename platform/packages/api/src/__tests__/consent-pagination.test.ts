import { describe, it, expect, vi } from 'vitest';
import { paginateWithConsent, CONSENT_SCAN_FLOOR } from '../consent-pagination.js';

// Raw rows are numbers; "visible" rows are the even ones (simulating consent).
const onlyEven = async (raw: number[]) => raw.filter((n) => n % 2 === 0);

function fetchFromArray(all: number[]) {
  return async (windowLimit: number) => ({
    items: all.slice(0, windowLimit),
    total: all.length,
  });
}

describe('paginateWithConsent', () => {
  it('filters by consent before slicing the page', async () => {
    // 10 rows, evens visible → [0,2,4,6,8]
    const r = await paginateWithConsent(0, 2, fetchFromArray([0,1,2,3,4,5,6,7,8,9]), onlyEven);
    expect(r.items).toEqual([0, 2]);
    expect(r.totalCount).toBe(5); // exact: window covered all rows
    expect(r.hasNextPage).toBe(true);
  });

  it('returns later pages of consent-visible rows (reachability)', async () => {
    const all = Array.from({ length: 20 }, (_, i) => i); // evens: 0..18 (10 visible)
    const r = await paginateWithConsent(4, 2, fetchFromArray(all), onlyEven);
    expect(r.items).toEqual([8, 10]); // 5th and 6th visible rows
    expect(r.totalCount).toBe(10);
    expect(r.hasNextPage).toBe(true);
  });

  it('reports no next page on the last consent-visible page', async () => {
    const all = [0, 1, 2, 3, 4, 5]; // evens: 0,2,4 (3 visible)
    const r = await paginateWithConsent(2, 2, fetchFromArray(all), onlyEven);
    expect(r.items).toEqual([4]);
    expect(r.totalCount).toBe(3);
    expect(r.hasNextPage).toBe(false);
  });

  it('scans a window large enough to cover the requested offset', async () => {
    const fetch = vi.fn(async (windowLimit: number) => ({
      items: Array.from({ length: Math.min(windowLimit, 5000) }, (_, i) => i),
      total: 5000,
    }));
    await paginateWithConsent(2000, 10, fetch, async (r) => r);
    // window must be >= offset + limit + 1 so page 2000 is reachable
    const windowLimit = fetch.mock.calls[0]![0];
    expect(windowLimit).toBeGreaterThanOrEqual(2011);
  });

  it('uses at least the scan floor for small offsets', async () => {
    const fetch = vi.fn(async (_windowLimit: number) => ({ items: [], total: 0 }));
    await paginateWithConsent(0, 10, fetch, async (r) => r);
    expect(fetch.mock.calls[0]![0]).toBe(CONSENT_SCAN_FLOOR);
  });

  it('flags hasNextPage when the scan window did not cover all matches', async () => {
    // total far exceeds the hard cap window; all visible.
    const fetch = async (windowLimit: number) => ({
      items: Array.from({ length: windowLimit }, (_, i) => i),
      total: 1_000_000,
    });
    const r = await paginateWithConsent(0, 10, fetch, async (x) => x);
    expect(r.items).toHaveLength(10);
    expect(r.hasNextPage).toBe(true); // window incomplete → more pages exist
  });
});
