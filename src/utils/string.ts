/**
 * String utility functions for text comparison and manipulation
 */

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Locale-, number- and case-insensitive string comparison so names with
 * embedded numbers order naturally (e.g. "Урок 2" < "Урок 10").
 */
export function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b);
}

/**
 * Calculate Levenshtein distance between two strings using two rolling rows
 * (O(min) memory, no per-call matrix). When `maxDistance` is given, bails out
 * early once every cell of a row exceeds it — the true distance can then only
 * be larger, so `maxDistance + 1` is returned as a "too far apart" sentinel.
 */
export function levenshteinDistance(a: string, b: string, maxDistance?: number): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);
  for (let j = 0; j <= a.length; j++) prev[j] = j;

  for (let i = 1; i <= b.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= a.length; j++) {
      curr[j] =
        b.charAt(i - 1) === a.charAt(j - 1)
          ? prev[j - 1]
          : Math.min(
              prev[j - 1] + 1, // substitution
              curr[j - 1] + 1, // insertion
              prev[j] + 1 // deletion
            );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (maxDistance !== undefined && rowMin > maxDistance) return maxDistance + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[a.length];
}

/**
 * Calculate similarity percentage between two strings using Levenshtein distance
 * @param a First string
 * @param b Second string
 * @returns Similarity percentage from 0 to 100
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (!a && !b) return 100;
  if (!a || !b) return 0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);

  // Convert distance to similarity percentage
  const similarity = ((maxLength - distance) / maxLength) * 100;

  return Math.max(0, Math.min(100, similarity));
}

/**
 * Whether similarity(a, b) exceeds `thresholdPct`, computed cheaply: distance
 * is at least the length difference, so similarity is at most minLen/maxLen —
 * when even that upper bound can't clear the threshold, no DP runs at all (the
 * dominant case when comparing many unrelated strings). Otherwise the distance
 * computation bails as soon as the threshold is out of reach.
 */
export function levenshteinSimilarityAbove(a: string, b: string, thresholdPct: number): boolean {
  if (!a && !b) return 100 > thresholdPct;
  if (!a || !b) return 0 > thresholdPct;

  const maxLength = Math.max(a.length, b.length);
  const minLength = Math.min(a.length, b.length);
  if ((minLength / maxLength) * 100 <= thresholdPct) return false;

  // similarity > threshold  ⇔  distance < maxLength · (1 − threshold/100)
  const maxDistance = Math.ceil(maxLength * (1 - thresholdPct / 100)) + 1;
  const distance = levenshteinDistance(a, b, maxDistance);
  const similarity = ((maxLength - distance) / maxLength) * 100;
  return similarity > thresholdPct;
}
