/**
 * Seeded pseudo-random number generator (Mulberry32).
 *
 * Deterministic: same seed produces same sequence.
 * This ensures reproducible test data across runs.
 */
export function createRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element from an array. */
export function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

/** Pick a random element using weighted distribution. */
export function weightedPick<T>(items: readonly T[], weights: readonly number[], rng: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}

/** Shuffle an array in place (Fisher-Yates). */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** Generate a random integer in [min, max] inclusive. */
export function randInt(min: number, max: number, rng: () => number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Generate a random ISO date string between two years. */
export function randDate(startYear: number, endYear: number, rng: () => number): string {
  const start = new Date(startYear, 0, 1).getTime();
  const end = new Date(endYear, 11, 31).getTime();
  const ts = start + rng() * (end - start);
  return new Date(ts).toISOString().split('T')[0]!;
}

/** Generate a random ISO datetime string between two dates. */
export function randDateTime(startYear: number, endYear: number, rng: () => number): string {
  const start = new Date(startYear, 0, 1).getTime();
  const end = new Date(endYear, 11, 31).getTime();
  const ts = start + rng() * (end - start);
  return new Date(ts).toISOString();
}
