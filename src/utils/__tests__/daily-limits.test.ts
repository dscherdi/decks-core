import { applyDeckDailyLimits, limitDeckStatRows, type DailyLimitProfile } from "../daily-limits";

const open: DailyLimitProfile = {
  hasNewCardsLimitEnabled: false,
  newCardsPerDay: 20,
  hasReviewCardsLimitEnabled: false,
  reviewCardsPerDay: 100,
};
const limited: DailyLimitProfile = { ...open, hasNewCardsLimitEnabled: true, hasReviewCardsLimitEnabled: true, reviewCardsPerDay: 50 };

describe("daily limits", () => {
  it("offers what is left of each limit after today's studying", () => {
    expect(applyDeckDailyLimits({ newCount: 653, dueCount: 80 }, limited, { newCount: 5, reviewCount: 40 })).toEqual({
      newCount: 15,
      dueCount: 10,
    });
    expect(applyDeckDailyLimits({ newCount: 3, dueCount: 2 }, limited, { newCount: 0, reviewCount: 0 })).toEqual({
      newCount: 3,
      dueCount: 2,
    });
    expect(applyDeckDailyLimits({ newCount: 30, dueCount: 0 }, { ...limited, newCardsPerDay: 0 }, { newCount: 0, reviewCount: 0 }).newCount).toBe(0);
    expect(applyDeckDailyLimits({ newCount: 653, dueCount: 80 }, open, { newCount: 99, reviewCount: 99 })).toEqual({
      newCount: 653,
      dueCount: 80,
    });
  });

  it("limits each deck's row by its own profile, leaving a deck it does not know as it is", () => {
    const rows = [
      { deckId: "vocab", newCount: 2276, dueCount: 0, total: 2276 },
      { deckId: "notes", newCount: 4, dueCount: 1, total: 9 },
      { deckId: "unknown", newCount: 7, dueCount: 7, total: 14 },
    ];
    const decks = [
      { id: "vocab", profile: limited },
      { id: "notes", profile: open },
    ];
    expect(limitDeckStatRows(rows, decks, [{ deckId: "vocab", newCount: 12, reviewCount: 0 }])).toEqual([
      { deckId: "vocab", newCount: 8, dueCount: 0, total: 2276 },
      { deckId: "notes", newCount: 4, dueCount: 1, total: 9 },
      { deckId: "unknown", newCount: 7, dueCount: 7, total: 14 },
    ]);
  });
});
