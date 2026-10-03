import { FSRS } from "../../algorithm/fsrs";
import { REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN, type FSRSProfile } from "../../algorithm/fsrs-weights";
import type { IDatabaseService } from "../../database/DatabaseService.interface";
import { DEFAULT_DECK_PROFILE, type Flashcard } from "../../database/types";
import { DEFAULT_SETTINGS } from "../../settings";
import { addCalendarDays, studyDayKey, studyDayStart } from "../../utils/date-utils";
import { StatisticsService } from "../StatisticsService";

// 02:00 on the 15th: before the 04:00 rollover, so today is still the 14th's study day.
const NOW = new Date(2026, 0, 15, 2);

function card(id: string, due: Date, extra: Partial<Flashcard> = {}): Flashcard {
  return {
    id,
    deckId: "a",
    front: id,
    back: "answer",
    type: "header-paragraph",
    sourceFile: "a.md",
    contentHash: "hash",
    breadcrumb: "",
    notes: "",
    tags: [],
    hint: "",
    suspendedAt: null,
    buriedUntil: null,
    clozeText: null,
    clozeOrder: null,
    anchor: null,
    state: "review",
    dueDate: due.toISOString(),
    interval: 1440,
    repetitions: 3,
    // Long enough that the simulation adds no review inside a short window.
    stability: 400,
    difficulty: 5,
    lapses: 0,
    lastReviewed: new Date(due.getTime() - 30 * 86400000).toISOString(),
    created: "2025-01-01T00:00:00.000Z",
    modified: "2025-01-01T00:00:00.000Z",
    ...extra,
  };
}

interface ReviewAt {
  card: string;
  at: Date;
  /** The card's state when studied; new cards don't count against the review limit. */
  state?: "new" | "review";
}

interface DeckSetup {
  /** Review cards per day; without one, capacity is the average of the 30 days before today. */
  limit?: number;
  retention?: number;
  weights?: FSRSProfile;
  reviews?: ReviewAt[];
}

const STANDARD = new FSRS({ requestRetention: 0.9, profile: "STANDARD", nextDayStartsAt: 4 });

// Weights unlike the shipped ones, for a TRAINED deck.
const TRAINED_WEIGHTS = [
  0.3, 1.1, 2.5, 9, 6, 0.9, 2.8, 0.01, 1.0, 0.2, 0.9, 1.4, 0.07, 0.3, 1.5, 0.5, 1.9, 0.6, 0.1, 0.07, 0.2,
];

/**
 * The study days a lone card is due on when the scheduler reviews it "Good" each time it comes due, at its due
 * time or the day's start, and any return within a study day it was studied on moved to the next.
 */
function scheduledDays(c: Flashcard, totalDays: number, fsrs = STANDARD, rollover = 4): number[] {
  const starts = Array.from({ length: totalDays + 1 }, (_, i) =>
    addCalendarDays(studyDayStart(NOW, rollover), i).getTime()
  );
  const counts = new Array<number>(totalDays).fill(0);
  let current = c;
  let due = new Date(c.dueDate).getTime();
  const studied = c.lastReviewed ? new Date(c.lastReviewed).getTime() : NaN;
  if (studied >= starts[0] && due < starts[1]) due = starts[1];
  while (due >= starts[0] && due < starts[totalDays]) {
    let day = 0;
    while (starts[day + 1] <= due) day++;
    counts[day]++;
    current = fsrs.updateCard(current, "good", new Date(Math.max(due, starts[day])));
    due = Math.max(new Date(current.dueDate).getTime(), starts[day + 1]);
  }
  return counts;
}

// `n` review cards studied in the 30 days before today's study day, each on its own card.
function history(n: number): ReviewAt[] {
  return Array.from({ length: n }, (_, i) => ({ card: `h${i}`, at: new Date(2026, 0, 13 - (i % 29), 12) }));
}

function serviceWith(
  cards: Flashcard[],
  decks: Record<string, DeckSetup> = {},
  trained: number[] | null = null,
  rollover = 4
): StatisticsService {
  const db = {
    getActiveTrainedWeightSet: async () => (trained ? { id: "trained", weights: trained } : null),
    getFlashcardsByDeck: async (deckId: string) => cards.filter((c) => c.deckId === deckId),
    getDeckWithProfile: async (deckId: string) => {
      const setup = decks[deckId] ?? {};
      return {
        id: deckId,
        profile: {
          ...DEFAULT_DECK_PROFILE,
          hasReviewCardsLimitEnabled: setup.limit !== undefined,
          reviewCardsPerDay: setup.limit ?? 0,
          fsrs: {
            ...DEFAULT_DECK_PROFILE.fsrs,
            requestRetention: setup.retention ?? 0.9,
            profile: setup.weights ?? "STANDARD",
          },
        },
      };
    },
    countReviewCardDays: async (deckId: string, from: string, to: string, nextDayStartsAt: number) => {
      const studied = (decks[deckId]?.reviews ?? []).filter(
        (r) => (r.state ?? "review") === "review" && r.at >= new Date(from) && r.at < new Date(to)
      );
      return new Set(studied.map((r) => `${r.card}|${studyDayKey(r.at, nextDayStartsAt)}`)).size;
    },
  } as unknown as IDatabaseService;
  return new StatisticsService(db, {
    ...DEFAULT_SETTINGS,
    review: { ...DEFAULT_SETTINGS.review, nextDayStartsAt: rollover },
  });
}

describe("the backlog forecast", () => {
  it("keys each day by study day, before the rollover too", async () => {
    const out = await serviceWith([]).simulateFutureDueLoad(["a"], 3, NOW);
    expect(out.map((d) => d.date)).toEqual(["2026-01-14", "2026-01-15", "2026-01-16"]);
  });

  it("counts a stored due date once, on its study day, for one deck or several", async () => {
    // 03:00 on the 16th is still the 15th's study day.
    const cards = [card("due", new Date(2026, 0, 16, 3))];
    for (const decks of [["a"], ["a", "b"]]) {
      const out = await serviceWith(cards).simulateFutureDueLoad(decks, 3, NOW);
      expect(out.map((d) => d.scheduledDue)).toEqual([0, 1, 0]);
    }
  });

  it("leaves out suspended and buried cards, and keeps one whose burial has passed", async () => {
    const due = new Date(2026, 0, 15, 12);
    const cards = [
      card("suspended", due, { suspendedAt: "2026-01-10T00:00:00.000Z" }),
      card("buried", due, { buriedUntil: new Date(2026, 0, 16).toISOString() }),
      card("unburied", due, { buriedUntil: new Date(2026, 0, 14).toISOString() }),
      card("new", due, { state: "new" }),
    ];
    const out = await serviceWith(cards).simulateFutureDueLoad(["a"], 3, NOW);
    expect(out.map((d) => d.scheduledDue)).toEqual([0, 1, 0]);
  });

  it("starts from the cards already overdue", async () => {
    const out = await serviceWith([card("late", new Date(2026, 0, 10, 12))]).simulateFutureDueLoad(["a"], 2, NOW);
    expect(out[0]).toMatchObject({ scheduledDue: 0, projectedBacklog: 1 });
  });

  it("simulates every card's next review, not six a day across the deck", async () => {
    // Ten alike cards due on the 15th's study day come round again together.
    const cards = Array.from({ length: 10 }, (_, i) =>
      card(`c${i}`, new Date(2026, 0, 15, 12), {
        stability: 1,
        lastReviewed: new Date(2026, 0, 14, 12).toISOString(),
      })
    );
    const out = await serviceWith(cards, { a: { limit: 100 } }).simulateFutureDueLoad(["a"], 10, NOW);
    expect(out[1].scheduledDue).toBe(10);
    expect(Math.max(...out.slice(2).map((d) => d.scheduledDue))).toBe(10);
  });

  it("steps each card as the scheduler does, at the deck's retention and any rollover", async () => {
    const cards = [
      card("lapsed", new Date(2026, 0, 15, 6), { stability: 0.1, difficulty: 10, lastReviewed: new Date(2026, 0, 15, 1).toISOString() }),
      card("young", new Date(2026, 0, 15, 20), { stability: 1, difficulty: 5, lastReviewed: new Date(2026, 0, 14, 20).toISOString() }),
      card("hard", new Date(2026, 0, 16, 3), { stability: 0.6, difficulty: 9.5, lastReviewed: new Date(2026, 0, 14, 12).toISOString() }),
      card("easy", new Date(2026, 0, 17, 12), { stability: 4, difficulty: 2, lastReviewed: new Date(2026, 0, 13, 12).toISOString() }),
      card("late", new Date(2026, 0, 16, 1), { stability: 1, difficulty: 10, lastReviewed: new Date(2026, 0, 15, 1).toISOString() }),
    ];
    for (const rollover of [0, 4, 6]) {
      for (const retention of [0.85, 0.9, 0.97]) {
        const fsrs = new FSRS({ requestRetention: retention, profile: "STANDARD", nextDayStartsAt: rollover });
        for (const c of cards) {
          const service = serviceWith([c], { a: { limit: 100, retention } }, null, rollover);
          const out = await service.simulateFutureDueLoad(["a"], 40, NOW);
          expect({ card: c.id, rollover, retention, due: out.map((d) => d.scheduledDue) }).toEqual({
            card: c.id,
            rollover,
            retention,
            due: scheduledDays(c, 40, fsrs, rollover),
          });
        }
      }
    }
  });

  it("steps a TRAINED deck with the active trained weights, else the standard ones", async () => {
    const c = card("young", new Date(2026, 0, 15, 20), {
      stability: 1,
      difficulty: 5,
      lastReviewed: new Date(2026, 0, 14, 20).toISOString(),
    });
    const trained = new FSRS({ requestRetention: 0.9, profile: "TRAINED", weights: TRAINED_WEIGHTS, nextDayStartsAt: 4 });
    const due = async (weights: number[] | null) =>
      (await serviceWith([c], { a: { limit: 100, weights: "TRAINED" } }, weights).simulateFutureDueLoad(["a"], 60, NOW)).map(
        (d) => d.scheduledDue
      );
    expect(await due(TRAINED_WEIGHTS)).toEqual(scheduledDays(c, 60, trained));
    expect(scheduledDays(c, 60, trained)).not.toEqual(scheduledDays(c, 60));
    expect(await due(null)).toEqual(scheduledDays(c, 60));
    expect(await due([1, 2, 3])).toEqual(scheduledDays(c, 60));
    // A STANDARD deck keeps the shipped weights while a trained set is active.
    const standard = await serviceWith([c], { a: { limit: 100 } }, TRAINED_WEIGHTS).simulateFutureDueLoad(["a"], 60, NOW);
    expect(standard.map((d) => d.scheduledDue)).toEqual(scheduledDays(c, 60));
  });

  it("uses the default retention where a deck's stored one is unusable", async () => {
    const c = card("young", new Date(2026, 0, 15, 20), {
      stability: 1,
      difficulty: 5,
      lastReviewed: new Date(2026, 0, 14, 20).toISOString(),
    });
    const out = await serviceWith([c], { a: { limit: 100, retention: 0.3 } }).simulateFutureDueLoad(["a"], 40, NOW);
    expect(out.map((d) => d.scheduledDue)).toEqual(scheduledDays(c, 40));
  });

  it("steps a deck at either end of the retention range with that retention, not the default", async () => {
    const c = card("young", new Date(2026, 0, 15, 20), {
      stability: 1,
      difficulty: 5,
      lastReviewed: new Date(2026, 0, 14, 20).toISOString(),
    });
    for (const retention of [REQUEST_RETENTION_MIN, REQUEST_RETENTION_MAX]) {
      const fsrs = new FSRS({ requestRetention: retention, profile: "STANDARD", nextDayStartsAt: 4 });
      const out = await serviceWith([c], { a: { limit: 100, retention } }).simulateFutureDueLoad(["a"], 60, NOW);
      const due = out.map((d) => d.scheduledDue);
      expect({ retention, due }).toEqual({ retention, due: scheduledDays(c, 60, fsrs) });
      expect(due).not.toEqual(scheduledDays(c, 60));
    }
  });

  it("steps a card with no last review as if reviewed just now, as the scheduler does", async () => {
    const c = card("unreviewed", new Date(2026, 0, 15, 12), { stability: 2, difficulty: 6, lastReviewed: null });
    // The scheduler reads a missing last review as the moment of review: here, noon on the 15th.
    const studiedAtDue = { ...c, lastReviewed: c.dueDate };
    const out = await serviceWith([c], { a: { limit: 100 } }).simulateFutureDueLoad(["a"], 10, NOW);
    expect(out.map((d) => d.scheduledDue)).toEqual(scheduledDays(studiedAtDue, 10));
  });

  it("reviews a card once a study day, and keeps a lapsed one with sub-day intervals coming back", async () => {
    // A lapsed card would come back within hours: each return waits for the next study day.
    const due = new Date(2026, 0, 15, 6);
    const leech = card("leech", due, {
      stability: 0.1,
      difficulty: 10,
      lastReviewed: new Date(due.getTime() - 0.1 * 86400000).toISOString(),
    });
    const out = await serviceWith([leech], { a: { limit: 100 } }).simulateFutureDueLoad(["a"], 8, NOW);
    expect(out.map((d) => d.scheduledDue)).toEqual(scheduledDays(leech, 8));
    expect(out.slice(1, 4).map((d) => d.scheduledDue)).toEqual([1, 1, 1]);
  });

  it("counts a return before the rollover on the study day it falls in", async () => {
    // Reviewed at 03:00 on the 16th, back about 23 hours later: before 04:00 on the 17th, so still the 16th's day.
    const due = new Date(2026, 0, 16, 3);
    const late = card("late", due, {
      stability: 0.6,
      difficulty: 10,
      lastReviewed: new Date(due.getTime() - 0.6 * 86400000).toISOString(),
    });
    const out = await serviceWith([late], { a: { limit: 10 } }).simulateFutureDueLoad(["a"], 4, NOW);
    expect(out.map((d) => d.scheduledDue)).toEqual([0, 1, 1, 0]);
    expect(out.map((d) => d.scheduledDue)).toEqual(scheduledDays(late, 4));
  });

  it("adds what today's capacity can't take, after the review cards already studied", async () => {
    // 200 cards due later today, ten a day, and four review cards studied already.
    const cards = Array.from({ length: 200 }, (_, i) => card(`c${i}`, new Date(2026, 0, 15, 3)));
    const studied = ["r1", "r2", "r3", "r4"].map((id) => ({ card: id, at: new Date(2026, 0, 14, 20) }));
    // A new card studied today and a review card studied twice cost no more of the limit.
    const reviews = [...studied, { card: "n1", at: new Date(2026, 0, 14, 21), state: "new" as const }, { card: "r1", at: new Date(2026, 0, 14, 22) }];
    const out = await serviceWith(cards, { a: { limit: 10, reviews } }).simulateFutureDueLoad(["a"], 3, NOW);
    expect(out.map((d) => d.scheduledDue)).toEqual([200, 0, 0]);
    expect(out.map((d) => d.projectedBacklog)).toEqual([194, 184, 174]);
  });

  it("counts today's reviews from the rollover, and the pace from the 30 days before it", async () => {
    const cards = Array.from({ length: 100 }, (_, i) => card(`c${i}`, new Date(2026, 0, 10, 12)));
    // 03:30 on the 14th is the 13th's study day; 04:30 is today's.
    const around = [
      { card: "before", at: new Date(2026, 0, 14, 3, 30) },
      { card: "after", at: new Date(2026, 0, 14, 4, 30) },
    ];
    const today = await serviceWith(cards, { a: { limit: 10, reviews: around } }).simulateFutureDueLoad(["a"], 1, NOW);
    expect(today[0].projectedBacklog).toBe(91);

    // One review inside the 30 days before today and one outside set a pace of one in 30 days;
    // today's two are not part of it, and already spend today's share, so the first review is on day 30.
    const reviews = [
      { card: "in", at: new Date(2025, 11, 16, 12) },
      { card: "out", at: new Date(2025, 11, 14, 12) },
      { card: "t1", at: new Date(2026, 0, 14, 10) },
      { card: "t2", at: new Date(2026, 0, 14, 11) },
    ];
    const out = await serviceWith(cards, { a: { reviews } }).simulateFutureDueLoad(["a"], 31, NOW);
    expect([14, 29, 30].map((d) => out[d].projectedBacklog)).toEqual([100, 100, 99]);
  });

  it("works through an average pace's fractions over the days", async () => {
    // 75 review cards in the last 30 days: two and a half a day.
    const cards = Array.from({ length: 100 }, (_, i) => card(`c${i}`, new Date(2026, 0, 10, 12)));
    const out = await serviceWith(cards, { a: { reviews: history(75) } }).simulateFutureDueLoad(["a"], 10, NOW);
    expect(out.map((d) => d.projectedBacklog)).toEqual([98, 95, 93, 90, 88, 85, 83, 80, 78, 75]);
  });

  it("spends a slow pace on the day its total reaches a whole review", async () => {
    // Three in 30 days: one every tenth day, though 0.1 added ten times falls short of 1 in floating point.
    const cards = Array.from({ length: 20 }, (_, i) => card(`c${i}`, new Date(2026, 0, 10, 12)));
    const out = await serviceWith(cards, { a: { reviews: history(3) } }).simulateFutureDueLoad(["a"], 31, NOW);
    expect([8, 9, 19, 29].map((d) => out[d].projectedBacklog)).toEqual([20, 19, 18, 17]);
  });

  it("brings a card studied today and due again later today back tomorrow", async () => {
    const again = card("again", new Date(2026, 0, 15, 3), {
      stability: 0.3,
      lastReviewed: new Date(2026, 0, 14, 22).toISOString(),
    });
    const out = await serviceWith([again], { a: { limit: 100 } }).simulateFutureDueLoad(["a"], 2, NOW);
    expect(out.map((d) => d.scheduledDue)).toEqual([0, 1]);
  });

  it("reviews the longest-waiting cards first", async () => {
    // One review a day. The overdue card is lapsed: reviewed first, it is back the next day while the other waits.
    const overdue = card("overdue", new Date(2026, 0, 14, 2, 24), {
      stability: 0.1,
      difficulty: 10,
      lastReviewed: new Date(2026, 0, 14).toISOString(),
    });
    const today = card("today", new Date(2026, 0, 15, 3));
    const out = await serviceWith([today, overdue], { a: { limit: 1 } }).simulateFutureDueLoad(["a"], 4, NOW);
    expect(out.slice(0, 2).map((d) => d.scheduledDue)).toEqual([1, 1]);

    // Two due the same day, listed latest first: the earlier one is reviewed, so the hard one's return is late.
    const hard = card("hard", new Date(2026, 0, 15, 20), {
      stability: 0.5,
      difficulty: 10,
      lastReviewed: new Date(2026, 0, 14, 20).toISOString(),
    });
    const early = card("early", new Date(2026, 0, 15, 6));
    const sameDay = await serviceWith([hard, early], { a: { limit: 1 } }).simulateFutureDueLoad(["a"], 4, NOW);
    expect(sameDay.map((d) => d.scheduledDue)).toEqual([0, 2, 0, 0]);
  });

  it("never grows the backlog past the cards when nothing is reviewed", async () => {
    const cards = Array.from({ length: 100 }, (_, i) =>
      card(`c${i}`, new Date(2026, 0, 10, 12), { stability: 2 })
    );
    const out = await serviceWith(cards).simulateFutureDueLoad(["a"], 31, NOW);
    expect(out.every((d) => d.projectedBacklog === 100 && d.scheduledDue === 0)).toBe(true);
  });

  it("simulates each deck with its own retention and capacity, and adds them up", async () => {
    const cards = [
      ...Array.from({ length: 40 }, (_, i) =>
        card(`a${i}`, new Date(2026, 0, 13, 12), { deckId: "a", stability: 1 })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        card(`b${i}`, new Date(2026, 0, 15 + (i % 5), 12), { deckId: "b", stability: 3 })
      ),
    ];
    const decks = { a: { limit: 5, retention: 0.97 }, b: { limit: 30, retention: 0.85 } };
    const service = serviceWith(cards, decks);
    const alone = await Promise.all(["a", "b"].map((id) => service.simulateFutureDueLoad([id], 20, NOW)));
    const sum = alone[0].map((day, i) => ({
      date: day.date,
      scheduledDue: day.scheduledDue + alone[1][i].scheduledDue,
      projectedBacklog: day.projectedBacklog + alone[1][i].projectedBacklog,
    }));
    expect(await service.simulateFutureDueLoad(["a", "b"], 20, NOW)).toEqual(sum);
    expect(await service.simulateFutureDueLoad(["b", "a", "b"], 20, NOW)).toEqual(sum);
    // Deck a reviews five a day, whatever deck b leaves spare.
    expect(alone[0][0].projectedBacklog).toBe(35);
  });

  it("brings cards back sooner at a higher retention", async () => {
    const cards = ["a", "b"].flatMap((deckId) =>
      Array.from({ length: 20 }, (_, i) => card(`${deckId}${i}`, new Date(2026, 0, 15, 12), { deckId, stability: 3 }))
    );
    const service = serviceWith(cards, { a: { limit: 50, retention: 0.97 }, b: { limit: 50, retention: 0.85 } });
    const total = async (deckId: string) =>
      (await service.simulateFutureDueLoad([deckId], 30, NOW)).reduce((n, d) => n + d.scheduledDue, 0);
    expect(await total("a")).toBeGreaterThan(await total("b"));
  });

  it("lines the backlog up with the chart's days by date, gaps included", async () => {
    const out = await serviceWith([card("late", new Date(2026, 0, 10, 12))]).simulateFutureDueLoad(["a"], 3, NOW);
    const shown = [{ date: "2026-01-14" }, { date: "2026-01-16" }, { date: "2026-02-01" }];
    expect(serviceWith([]).backlogOnDays(shown, out)).toEqual([1, 1, null]);
  });
});
