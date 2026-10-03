import type { RubricCode } from "./critique-prompt";

/** The hub's arithmetic, kept out of the component so it can be tested. */

export interface SessionCounts {
  staged: number;
  flagged: number;
  saved: number;
  /** The page span the session's live and saved cards cite, when any do. */
  firstPage?: number | null;
  lastPage?: number | null;
}

/** Keep rate over decided cards only; null when nothing has been decided. */
export function keepRate(saved: number, discarded: number): number | null {
  const decided = saved + discarded;
  if (decided === 0) return null;
  return Math.round((saved / decided) * 100);
}

/** Tally flagged cards by the rule they broke, most common first. */
export function flagTally(
  cards: ReadonlyArray<{ rubricCodes: RubricCode[] }>,
): Array<{ code: RubricCode; count: number }> {
  const counts = new Map<RubricCode, number>();
  for (const card of cards) {
    // A card breaking two rules is counted under both: the chips name work to
    // be done, and both rules still need attention on that card.
    for (const code of new Set(card.rubricCodes)) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export interface HubTotals {
  staged: number;
  flagged: number;
  sessions: number;
}

/** Totals across the live sessions the hub is showing. */
export function hubTotals(
  counts: ReadonlyArray<SessionCounts>,
): HubTotals {
  let staged = 0;
  let flagged = 0;
  for (const c of counts) {
    staged += c.staged;
    flagged += c.flagged;
  }
  // Sessions with nothing staged still count: an empty session is one you
  // started and have not generated into yet, not one that does not exist.
  return { staged, flagged, sessions: counts.length };
}

/** Coarse "how long ago". Returns a unit and a count, never a formatted
 *  string — shared logic must not hard-code English. */
export type RelativeUnit = "now" | "minute" | "hour" | "day" | "week";

export function relativeAge(
  iso: string,
  now: number = Date.now(),
): { unit: RelativeUnit; count: number } {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return { unit: "now", count: 0 };
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return { unit: "now", count: 0 };
  if (minutes < 60) return { unit: "minute", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { unit: "day", count: days };
  return { unit: "week", count: Math.floor(days / 7) };
}
