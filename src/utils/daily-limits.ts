import type { DeckProfile } from "../database/types";

export type DailyLimitProfile = Pick<
  DeckProfile,
  "hasNewCardsLimitEnabled" | "newCardsPerDay" | "hasReviewCardsLimitEnabled" | "reviewCardsPerDay"
>;

export interface DayCounts {
  newCount: number;
  dueCount: number;
}

export interface StudiedToday {
  newCount: number;
  reviewCount: number;
}

/** A deck's new and due cards within its profile's daily limits, after what it studied today. */
export function applyDeckDailyLimits(raw: DayCounts, profile: DailyLimitProfile, studied: StudiedToday): DayCounts {
  let newCount = raw.newCount;
  let dueCount = raw.dueCount;
  if (profile.hasNewCardsLimitEnabled && profile.newCardsPerDay >= 0) {
    newCount = Math.min(raw.newCount, Math.max(0, profile.newCardsPerDay - studied.newCount));
  }
  if (profile.hasReviewCardsLimitEnabled && profile.reviewCardsPerDay >= 0) {
    dueCount = Math.min(raw.dueCount, Math.max(0, profile.reviewCardsPerDay - studied.reviewCount));
  }
  return { newCount, dueCount };
}

/** Per-deck stat rows with each deck's daily limits applied; a deck with no known profile keeps its counts. */
export function limitDeckStatRows<T extends DayCounts & { deckId: string }>(
  rows: readonly T[],
  decks: readonly { id: string; profile: DailyLimitProfile }[],
  studied: readonly (StudiedToday & { deckId: string })[]
): T[] {
  const profiles = new Map(decks.map((deck) => [deck.id, deck.profile]));
  const today = new Map(studied.map((row) => [row.deckId, row]));
  return rows.map((row) => {
    const profile = profiles.get(row.deckId);
    if (!profile) return row;
    return { ...row, ...applyDeckDailyLimits(row, profile, today.get(row.deckId) ?? { newCount: 0, reviewCount: 0 }) };
  });
}
