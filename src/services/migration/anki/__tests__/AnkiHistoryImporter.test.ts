import { AnkiHistoryImporter } from "../AnkiHistoryImporter";
import type { AnkiRevlogRow, AnkiDeckItem } from "../AnkiHistoryImporter";
import type { AnkiParsedCard, AnkiScheduling } from "../AnkiTypes";
import type { HistoryDb } from "../../SrHistoryImporter";
import type { Flashcard, ReviewLog } from "../../../../database/types";
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

class MockHistoryDb implements HistoryDb {
  logs = new Map<string, ReviewLog>();
  updates: Array<{ id: string; updates: Partial<Flashcard> }> = [];

  insertReviewLog(reviewLog: ReviewLog): Promise<void> {
    this.logs.set(reviewLog.id, reviewLog);
    return Promise.resolve();
  }
  getReviewLogById(id: string): Promise<ReviewLog | null> {
    return Promise.resolve(this.logs.get(id) ?? null);
  }
  batchUpdateFlashcards(updates: Array<{ id: string; updates: Partial<Flashcard> }>): Promise<void> {
    this.updates.push(...updates);
    return Promise.resolve();
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
    const db = new MockHistoryDb();
    const items: AnkiDeckItem[] = [
      {
        deckId: "deck_x",
        profileFsrs: PROFILE,
        cards: [card({ front: "Hallo", scheduling: sched({ type: 2, ivl: 30, reps: 5, data: '{"s":4,"d":5}' }) })],
      },
    ];
    const first = await AnkiHistoryImporter.importHistory(db, items, {}, now);
    expect(first.injected).toBe(1);

    const cardId = generateFlashcardId("Hallo");
    expect(db.logs.has(`log_migrate_anki_${cardId}`)).toBe(true);
    expect(db.updates[0].updates.state).toBe("review");
    expect(db.updates[0].updates.stability).toBe(4);

    const second = await AnkiHistoryImporter.importHistory(db, items, {}, now);
    expect(second.injected).toBe(0); // already imported
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
    const db = new MockHistoryDb();
    await AnkiHistoryImporter.importHistory(
      db,
      [{ deckId: "deck_x", profileFsrs: PROFILE, cards: [clozeCard] }],
      {},
      now
    );
    const id = generateClozeFlashcardId("Du trinkst ==jeden Tag== Bier.", "jeden Tag", 0);
    expect(db.updates[0].id).toBe(id);
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
