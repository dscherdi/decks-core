import { AnkiHistoryImporter } from "../AnkiHistoryImporter";
import { AnkiDeckRenderer } from "../AnkiDeckRenderer";
import type { AnkiRevlogRow, AnkiDeckItem, AnkiHistoryDb } from "../AnkiHistoryImporter";
import type { AnkiParsedCard, AnkiScheduling } from "../AnkiTypes";
import type { Flashcard, ReviewLog } from "../../../../database/types";
import type { SqlJsValue } from "../../../../database/sql-types";
import { generateClozeFlashcardId, generateFlashcardId } from "../../../../utils/hash";

function sched(partial: Partial<AnkiScheduling>): AnkiScheduling {
  return { type: 0, queue: 0, due: 0, ivl: 0, factor: 0, reps: 0, lapses: 0, data: "{}", ...partial };
}

function card(partial: Partial<AnkiParsedCard>): AnkiParsedCard {
  return {
    noteId: 1,
    cardId: 100,
    ord: 0,
    kind: partial.isCloze ? "cloze" : "basic",
    isCloze: false,
    deckName: "Deck",
    front: "Front",
    back: "Back",
    notes: "",
    media: [],
    scheduling: sched({}),
    ...partial,
  };
}

interface MockRow {
  deckId: string;
  state: string;
  dueDate: string;
  interval: number;
  repetitions: number;
  difficulty: number;
  stability: number;
  lapses: number;
  lastReviewed: string | null;
}

/** Holds the deck rows the importer reads, and answers its one row query from them and the logs. */
class MockHistoryDb implements AnkiHistoryDb {
  logs = new Map<string, ReviewLog>();
  updates: Array<{ id: string; updates: Partial<Flashcard> }> = [];
  rows = new Map<string, MockRow>();

  /** A fresh row for every card, as the sync before history creates them. */
  seed(items: AnkiDeckItem[]): this {
    for (const item of items) {
      for (const c of item.cards) {
        this.rows.set(AnkiDeckRenderer.decksCardId(c), {
          deckId: item.deckId,
          state: "new",
          dueDate: "2026-01-01T00:00:00.000Z",
          interval: 0,
          repetitions: 0,
          difficulty: 5,
          stability: 2.5,
          lapses: 0,
          lastReviewed: null,
        });
      }
    }
    return this;
  }

  /** A review made in Decks: its log, and the state the scheduler leaves on the row. */
  reviewInDecks(cardId: string, at: string, stability: number): void {
    this.logs.set(`log_${Date.parse(at)}_x`, { id: `log_${Date.parse(at)}_x`, flashcardId: cardId, reviewedAt: at } as ReviewLog);
    const row = this.rows.get(cardId);
    if (row) Object.assign(row, { state: "review", stability, lastReviewed: at, repetitions: row.repetitions + 1 });
  }

  insertReviewLog(reviewLog: ReviewLog): Promise<void> {
    this.logs.set(reviewLog.id, reviewLog);
    return Promise.resolve();
  }
  getReviewLogById(id: string): Promise<ReviewLog | null> {
    return Promise.resolve(this.logs.get(id) ?? null);
  }
  batchUpdateFlashcards(updates: Array<{ id: string; updates: Partial<Flashcard> }>): Promise<void> {
    this.updates.push(...updates);
    for (const { id, updates: changes } of updates) {
      const row = this.rows.get(id);
      if (row) Object.assign(row, changes);
    }
    return Promise.resolve();
  }
  querySql<T>(_sql: string, params: SqlJsValue[] = []): Promise<T[]> {
    const imported = (id: string): boolean => id.startsWith("log_anki_") || id.startsWith("log_migrate_");
    const rows = [...this.rows]
      .filter(([id]) => params.includes(id))
      .map(([id, row]) => {
        const own = [...this.logs.values()]
          .filter((log) => log.flashcardId === id && !imported(log.id))
          .map((log) => log.reviewedAt)
          .sort();
        return {
          id,
          state: row.state,
          due_date: row.dueDate,
          interval: row.interval,
          repetitions: row.repetitions,
          difficulty: row.difficulty,
          stability: row.stability,
          lapses: row.lapses,
          last_reviewed: row.lastReviewed,
          own_reviewed_at: own.length ? own[own.length - 1] : null,
        };
      });
    return Promise.resolve(rows as T[]);
  }
}

const PROFILE = { requestRetention: 0.9, profile: "STANDARD" as const };

describe("AnkiHistoryImporter.buildFsrsState", () => {
  const now = new Date("2026-06-23T00:00:00Z");

  it("uses native FSRS stability/difficulty from the cards.data blob", () => {
    const state = AnkiHistoryImporter.buildFsrsState(
      sched({ type: 2, ivl: 30, reps: 5, lapses: 1, data: '{"s":4.52,"d":5.1}' }),
      undefined,
      now
    );
    expect(state?.stability).toBe(4.52);
    expect(state?.difficulty).toBe(5.1);
    expect(state?.reps).toBe(5);
    expect(state?.lapses).toBe(1);
  });

  it("converts SM-2 state to FSRS-6 when no blob is present", () => {
    const state = AnkiHistoryImporter.buildFsrsState(
      sched({ type: 2, ivl: 12, factor: 2500, reps: 3 }),
      undefined,
      now
    );
    expect(state?.stability).toBe(12); // stability ≈ interval
    expect(state?.difficulty).toBe(5); // ease 250 → bucket 5
  });

  it("buckets a low ease factor to a higher difficulty", () => {
    const state = AnkiHistoryImporter.buildFsrsState(
      sched({ type: 2, ivl: 8, factor: 2000, reps: 4 }),
      undefined,
      now
    );
    expect(state?.difficulty).toBe(8); // ease 200 < 210 → bucket 8
  });

  it("returns null for new cards", () => {
    expect(AnkiHistoryImporter.buildFsrsState(sched({}), undefined, now)).toBeNull();
  });
});

describe("AnkiHistoryImporter.importHistory", () => {
  const now = new Date("2026-06-23T00:00:00Z");

  it("injects state + a synthetic migration log, idempotently", async () => {
    const items: AnkiDeckItem[] = [
      {
        deckId: "deck_x",
        profileFsrs: PROFILE,
        cards: [card({ front: "Hallo", scheduling: sched({ type: 2, ivl: 30, reps: 5, data: '{"s":4,"d":5}' }) })],
      },
    ];
    const db = new MockHistoryDb().seed(items);
    const first = await AnkiHistoryImporter.importHistory(db, items, {}, now);
    expect(first.injected).toBe(1);

    const cardId = generateFlashcardId("Hallo");
    expect(db.logs.has(`log_migrate_anki_${cardId}`)).toBe(true);
    expect(db.updates[0].updates.state).toBe("review");
    expect(db.updates[0].updates.stability).toBe(4);

    const second = await AnkiHistoryImporter.importHistory(db, items, {}, now);
    expect(second.injected).toBe(0); // already imported
    expect(db.updates).toHaveLength(1); // nothing changed, so nothing rewritten
  });

  it("imports real revlog rows as a review timeline", async () => {
    const db = new MockHistoryDb();
    const cardId = generateFlashcardId("Hallo");
    const revlog: AnkiRevlogRow[] = [
      { id: 1700000000000, cid: 100, ease: 3, ivl: 4, lastIvl: 1, factor: 2500 },
      { id: 1700100000000, cid: 100, ease: 2, ivl: 6, lastIvl: 4, factor: 2300 },
    ];
    const items: AnkiDeckItem[] = [
      {
        deckId: "deck_x",
        profileFsrs: PROFILE,
        cards: [card({ front: "Hallo", scheduling: sched({ type: 2, ivl: 6, reps: 2 }) })],
      },
    ];
    const result = await AnkiHistoryImporter.importHistory(
      db,
      items,
      { revlogByCard: new Map([[100, revlog]]) },
      now
    );
    expect(result.reviews).toBe(2);
    expect(db.logs.has(`log_anki_${cardId}_1700000000000`)).toBe(true);
    expect(db.logs.get(`log_anki_${cardId}_1700000000000`)?.rating).toBe(3);
    expect(db.logs.get(`log_anki_${cardId}_1700100000000`)?.rating).toBe(2);
  });

  it("skips new cards (no state, no log)", async () => {
    const db = new MockHistoryDb();
    const items: AnkiDeckItem[] = [
      { deckId: "deck_x", profileFsrs: PROFILE, cards: [card({ front: "New", scheduling: sched({}) })] },
    ];
    const result = await AnkiHistoryImporter.importHistory(db, items, {}, now);
    expect(result.injected).toBe(0);
    expect(db.updates).toHaveLength(0);
  });

  it("computes a cloze card id from the cloze body (now always table-rendered)", async () => {
    const clozeCard = card({
      isCloze: true,
      front: "Du trinkst ==jeden Tag== Bier.",
      back: "Du trinkst ==jeden Tag== Bier.",
      clozeBody: "Du trinkst ==jeden Tag== Bier.",
      clozeText: "jeden Tag",
      clozeOrder: 0,
      scheduling: sched({ type: 2, ivl: 10, reps: 2 }),
    });
    const items: AnkiDeckItem[] = [{ deckId: "deck_x", profileFsrs: PROFILE, cards: [clozeCard] }];
    const db = new MockHistoryDb().seed(items);
    await AnkiHistoryImporter.importHistory(db, items, {}, now);
    const id = generateClozeFlashcardId("Du trinkst ==jeden Tag== Bier.", "jeden Tag", 0);
    expect(db.updates[0].id).toBe(id);
  });

  it("links history to the ids the rendered tokens carry, numbered fronts included", async () => {
    const make = (noteId: number, cardId: number, deckName: string, s: number): AnkiParsedCard =>
      card({
        noteId,
        cardId,
        deckName,
        front: "found",
        scheduling: sched({ type: 2, ivl: 20, reps: 3, data: `{"s":${s},"d":5}` }),
      });
    const first = make(1, 100, "Book::1", 6);
    const elsewhere = make(2, 200, "Book::2", 3);
    const sameDeck = make(3, 300, "Book::1", 4);
    // render mutates the shared card objects in place; the same objects flow to importHistory.
    const decks = AnkiDeckRenderer.render([first, elsewhere, sameDeck], "decks/anki", 2);
    expect(elsewhere.front).toBe("found");
    expect(sameDeck.front).toBe("found (2)");

    const items: AnkiDeckItem[] = decks.map((d) => ({
      deckId: `deck_${d.relativePath}`,
      profileFsrs: PROFILE,
      cards: d.cards,
    }));
    const db = new MockHistoryDb().seed(items);
    await AnkiHistoryImporter.importHistory(db, items, {}, now);

    const ids = [first, elsewhere, sameDeck].map((c) => AnkiDeckRenderer.decksCardId(c));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(db.logs.has(`log_migrate_anki_${id}`)).toBe(true);
    expect(db.updates.map((u) => u.id).sort()).toEqual([...ids].sort());
  });

  describe("on a re-import", () => {
    const first = Date.parse("2026-09-01T15:00:00Z");
    const later = Date.parse("2026-09-28T09:00:00Z");
    const answer = (id: number, ivl: number): AnkiRevlogRow => ({ id, cid: 100, ease: 3, ivl, lastIvl: 1, factor: 2500 });
    const deck = (scheduling: AnkiScheduling): AnkiDeckItem[] => [
      { deckId: "deck_x", profileFsrs: PROFILE, cards: [card({ front: "Hallo", scheduling })] },
    ];
    const initial = sched({ type: 2, ivl: 6, reps: 2, data: '{"s":6,"d":5}' });
    const cardId = (items: AnkiDeckItem[]): string => AnkiDeckRenderer.decksCardId(items[0].cards[0]);

    async function imported(): Promise<{ db: MockHistoryDb; items: AnkiDeckItem[] }> {
      const items = deck(initial);
      const db = new MockHistoryDb().seed(items);
      await AnkiHistoryImporter.importHistory(db, items, { revlogByCard: new Map([[100, [answer(first, 6)]]]) }, now);
      return { db, items };
    }

    it("takes Anki's state on the first import, dated by its last answer", async () => {
      const { db, items } = await imported();
      const row = db.rows.get(cardId(items));
      expect(row?.stability).toBe(6);
      expect(row?.lastReviewed).toBe(new Date(first).toISOString());
    });

    it("keeps the state of a card reviewed in Decks since", async () => {
      const { db, items } = await imported();
      db.reviewInDecks(cardId(items), "2026-09-20T10:00:00.000Z", 30);
      const pushed = db.updates.length;

      const result = await AnkiHistoryImporter.importHistory(
        db, items, { revlogByCard: new Map([[100, [answer(first, 6)]]]) }, now
      );

      expect(db.rows.get(cardId(items))?.stability).toBe(30);
      expect(db.updates).toHaveLength(pushed);
      expect(result.kept).toBe(1);
    });

    it("takes Anki's newer state for a card only reviewed in Anki", async () => {
      const { db } = await imported();
      const items = deck(sched({ type: 2, ivl: 20, reps: 3, data: '{"s":20,"d":5}' }));
      await AnkiHistoryImporter.importHistory(
        db, items, { revlogByCard: new Map([[100, [answer(first, 6), answer(later, 20)]]]) }, now
      );

      const row = db.rows.get(cardId(items));
      expect(row?.stability).toBe(20);
      expect(row?.lastReviewed).toBe(new Date(later).toISOString());
      expect(db.logs.has(`log_anki_${cardId(items)}_${later}`)).toBe(true);
    });

    it("lets an Anki answer later than the Decks review win", async () => {
      const { db, items: before } = await imported();
      db.reviewInDecks(cardId(before), "2026-09-20T10:00:00.000Z", 30);
      const items = deck(sched({ type: 2, ivl: 20, reps: 4, data: '{"s":20,"d":5}' }));
      await AnkiHistoryImporter.importHistory(
        db, items, { revlogByCard: new Map([[100, [answer(first, 6), answer(later, 20)]]]) }, now
      );
      expect(db.rows.get(cardId(items))?.stability).toBe(20);
    });

    it("keeps the Decks state when Anki has no answers to compare", async () => {
      const { db, items } = await imported();
      db.reviewInDecks(cardId(items), "2026-09-20T10:00:00.000Z", 30);
      await AnkiHistoryImporter.importHistory(db, items, {}, now);
      expect(db.rows.get(cardId(items))?.stability).toBe(30);
    });

    it("does not count a manual reschedule in Anki as an answer", async () => {
      const { db, items } = await imported();
      db.reviewInDecks(cardId(items), "2026-09-20T10:00:00.000Z", 30);
      const reschedule: AnkiRevlogRow = { ...answer(later, 20), ease: 0 };
      await AnkiHistoryImporter.importHistory(
        db, items, { revlogByCard: new Map([[100, [answer(first, 6), reschedule]]]) }, now
      );
      expect(db.rows.get(cardId(items))?.stability).toBe(30);
    });

    it("applies Anki's state to a card whose row another deck holds", async () => {
      const items = deck(initial);
      const db = new MockHistoryDb().seed([{ ...items[0], deckId: "deck_elsewhere" }]);
      await AnkiHistoryImporter.importHistory(db, items, {}, now);
      expect(db.rows.get(cardId(items))?.stability).toBe(6);
    });

    it("leaves a manual reschedule in Anki out of the card's log", async () => {
      const { db, items } = await imported();
      const reschedule: AnkiRevlogRow = { ...answer(later, 20), ease: 0 };
      await AnkiHistoryImporter.importHistory(
        db, items, { revlogByCard: new Map([[100, [answer(first, 6), reschedule]]]) }, now
      );
      expect(db.logs.has(`log_anki_${cardId(items)}_${later}`)).toBe(false);
    });

    it("writes history but no state for a card with no row anywhere", async () => {
      const items = deck(initial);
      const db = new MockHistoryDb();
      await AnkiHistoryImporter.importHistory(db, items, {}, now);
      expect(db.logs.has(`log_migrate_anki_${cardId(items)}`)).toBe(true);
      expect(db.updates).toHaveLength(0);
    });
  });

  it("reports progress with non-decreasing done up to the card total", async () => {
    const db = new MockHistoryDb();
    const cards = Array.from({ length: 5 }, (_, i) =>
      card({ noteId: i + 1, cardId: 100 + i, front: `q${i}`, scheduling: sched({ type: 2, ivl: 10, reps: 2 }) })
    );
    const calls: Array<[number, number]> = [];
    await AnkiHistoryImporter.importHistory(
      db,
      [{ deckId: "deck_x", profileFsrs: PROFILE, cards }],
      { onProgress: (done, total) => calls.push([done, total]) },
      now
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, total]) => total === cards.length)).toBe(true);
    // Monotonic non-decreasing done, ending exactly at total.
    const dones = calls.map(([done]) => done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    expect(dones[dones.length - 1]).toBe(cards.length);
  });
});
