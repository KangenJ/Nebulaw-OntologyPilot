/**
 * Consent-aware pagination.
 *
 * Consent visibility is decided per row and cannot be pushed into the storage
 * query, so paginating at the DB level and then dropping consent-restricted
 * rows is wrong: `totalCount`/`hasNextPage` drift, and pages can return fewer
 * than `limit` rows. The correct approach is to filter by consent BEFORE
 * slicing the page.
 *
 * To stay bounded we scan a window of matching rows (large enough to cover the
 * requested page, capped to avoid unbounded scans), apply consent, then slice.
 * For result sets larger than the hard cap, `totalCount` is the consent-visible
 * count within the scanned window (a lower bound) and `hasNextPage` stays true.
 * This is exact for any result set whose matching rows fit within the cap.
 */

/** Minimum rows scanned, so first-page totalCount is exact for typical sets. */
export const CONSENT_SCAN_FLOOR = 1000;
/** Hard ceiling on rows scanned in one consent-aware page request. */
export const CONSENT_SCAN_HARD_CAP = 10_000;

export interface ConsentPage<T> {
  items: T[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * @param offset       requested page offset (over consent-visible rows)
 * @param limit        requested page size
 * @param fetchWindow  fetch up to `windowLimit` matching rows from offset 0,
 *                     returning the raw rows and the pre-consent total
 * @param mapFilter    map + redact + consent-filter the raw rows into the
 *                     consent-visible, response-shaped rows
 */
export async function paginateWithConsent<R, T>(
  offset: number,
  limit: number,
  fetchWindow: (windowLimit: number) => Promise<{ items: R[]; total: number }>,
  mapFilter: (rawItems: R[]) => Promise<T[]>,
): Promise<ConsentPage<T>> {
  const windowLimit = Math.min(
    CONSENT_SCAN_HARD_CAP,
    Math.max(CONSENT_SCAN_FLOOR, offset + limit + 1),
  );
  const { items: rawWindow, total: rawTotal } = await fetchWindow(windowLimit);
  const visible = await mapFilter(rawWindow);

  const items = visible.slice(offset, offset + limit);
  const scannedAll = rawWindow.length >= rawTotal;
  const hasNextPage = visible.length > offset + limit || !scannedAll;
  // Exact when the window covered every matching row; otherwise a lower bound.
  const totalCount = scannedAll
    ? visible.length
    : Math.max(visible.length, offset + items.length);

  return { items, totalCount, hasNextPage };
}
