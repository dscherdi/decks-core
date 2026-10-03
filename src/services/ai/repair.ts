/** Review-time repair. */

/**
 * Fallback for a host with no leech threshold of its own.
 *
 * One lapse is ordinary forgetting and two can be timing; by the third the card
 * is the likelier fault. This is only the default — "how often is too often" is
 * the same question the leech threshold already answers, so a host that asks it
 * should pass that answer rather than keep a second number beside it.
 */
export const REPAIR_LAPSE_THRESHOLD = 3;

/**
 * Whether a card should offer to be repaired: it is lapsing often enough to be
 * the suspect, and there is a source to repair it from. An offer to re-read a
 * page nobody can name is not an offer.
 */
export function wantsRepair(
  lapses: number,
  hasSource: boolean,
  threshold: number = REPAIR_LAPSE_THRESHOLD,
): boolean {
  if (!hasSource) return false;
  if (!Number.isFinite(threshold)) return false;
  return Number.isFinite(lapses) && lapses >= threshold;
}
