/** Fisher-Yates shuffle and sampling for exam question draws. */

export function shuffleInPlace<T>(items: T[], rng: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = items[i];
    items[i] = items[j];
    items[j] = swap;
  }
  return items;
}

/** Uniform sample without replacement; count is clamped to the input size. */
export function sampleWithoutReplacement<T>(
  items: ReadonlyArray<T>,
  count: number,
  rng: () => number = Math.random
): T[] {
  const pool = [...items];
  shuffleInPlace(pool, rng);
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}
