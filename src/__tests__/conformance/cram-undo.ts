import { Scheduler } from "../../services/Scheduler";
import { DEFAULT_SETTINGS } from "../../settings";
import type { FileDeck, Flashcard, IDatabaseService, ISyncLog, SyncOpV1 } from "../../index";
import { type ConformanceHost, syncNote, table, testDeck } from "./harness";

/** Cram undo restores the cram row and graduated count exactly, and moves nothing else:
 *  no review logs, no flashcard state, no sync ops. */
export function describeCramUndo(host: ConformanceHost): void {
  describe(`cram undo (${host.label})`, () => {
    let db: IDatabaseService;
    let scheduler: Scheduler;
    let deck: FileDeck;
    let cards: Flashcard[];
    let syncOps: SyncOpV1[];
    const now = new Date();

    async function reviewLogCount(): Promise<number> {
      const rows = await db.querySql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM review_logs",
        [],
        { asObject: true }
      );
      return rows[0]?.n ?? 0;
    }

    beforeEach(async () => {
      db = await host.open();
      const deckId = await db.createDeck(testDeck({ filepath: "/test/cram-undo.md" }));
      await syncNote(db, deckId, table([["Alpha", "One"], ["Beta", "Two"]]));
      const withProfile = await db.getDeckWithProfile(deckId);
      if (!withProfile) throw new Error("deck missing");
      deck = { ...withProfile, type: "file" };
      cards = await db.getFlashcardsByDeck(deckId);
      expect(cards).toHaveLength(2);

      scheduler = new Scheduler(db, DEFAULT_SETTINGS, { createBackup: async () => undefined });
      syncOps = [];
      const syncLog: ISyncLog = {
        append: (op) => syncOps.push(op),
      };
      scheduler.setSyncLog(syncLog);
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("undoes a rating that left the card in the queue", async () => {
      const { sessionId } = await scheduler.startCramSession(deck, cards, now);
      const id = `${sessionId}:${cards[0].id}`;
      const before = await db.getCramCardById(id);

      const result = await scheduler.rateCram(sessionId, cards[0].id, "again", now);
      expect(result.graduated).toBe(false);
      expect((await db.getCramCardById(id))?.reps).toBe(1);
      expect(scheduler.hasUndoableCram(sessionId)).toBe(true);

      const shown = await scheduler.undoLastCramRating(sessionId);
      expect(shown?.id).toBe(cards[0].id);
      const after = await db.getCramCardById(id);
      expect(after).toMatchObject({
        tempState: before?.tempState,
        tempStability: before?.tempStability,
        tempDifficulty: before?.tempDifficulty,
        tempInterval: before?.tempInterval,
        tempDueAt: before?.tempDueAt,
        reps: 0,
        graduatedAt: null,
      });
      expect(scheduler.hasUndoableCram(sessionId)).toBe(false);
    });

    it("undoes a Good that retired the card, returning it to the queue", async () => {
      const original = await db.getFlashcardById(cards[0].id);
      const { sessionId } = await scheduler.startCramSession(deck, [cards[0]], now);

      const result = await scheduler.rateCram(sessionId, cards[0].id, "good", now);
      expect(result.graduated).toBe(true);
      expect((await scheduler.getCramProgress(sessionId))?.graduated).toBe(1);
      expect(await scheduler.getNextCramCard(sessionId)).toBeNull();

      const shown = await scheduler.undoLastCramRating(sessionId);
      expect(shown?.id).toBe(cards[0].id);
      const row = await db.getCramCardById(`${sessionId}:${cards[0].id}`);
      expect(row?.graduatedAt).toBeNull();
      expect(row?.reps).toBe(0);
      expect((await scheduler.getCramProgress(sessionId))?.graduated).toBe(0);
      expect((await scheduler.getNextCramCard(sessionId))?.id).toBe(cards[0].id);

      expect(await reviewLogCount()).toBe(0);
      expect(syncOps).toEqual([]);
      expect(await db.getFlashcardById(cards[0].id)).toEqual(original);
    });

    it("walks back several ratings in order", async () => {
      const { sessionId } = await scheduler.startCramSession(deck, cards, now);
      await scheduler.rateCram(sessionId, cards[0].id, "again", now);
      await scheduler.rateCram(sessionId, cards[1].id, "good", now);

      expect((await scheduler.undoLastCramRating(sessionId))?.id).toBe(cards[1].id);
      expect((await scheduler.undoLastCramRating(sessionId))?.id).toBe(cards[0].id);
      expect(await scheduler.undoLastCramRating(sessionId)).toBeNull();

      for (const card of cards) {
        const row = await db.getCramCardById(`${sessionId}:${card.id}`);
        expect(row?.reps).toBe(0);
        expect(row?.graduatedAt).toBeNull();
      }
      expect((await scheduler.getCramProgress(sessionId))?.graduated).toBe(0);
    });

    it("has nothing to undo before any rating", async () => {
      const { sessionId } = await scheduler.startCramSession(deck, cards, now);
      expect(scheduler.hasUndoableCram(sessionId)).toBe(false);
      expect(await scheduler.undoLastCramRating(sessionId)).toBeNull();
      expect(await scheduler.undoLastCramRating("no-such-session")).toBeNull();
    });

    it("forgets earlier ratings when a cram run starts", async () => {
      const first = await scheduler.startCramSession(deck, cards, now);
      await scheduler.rateCram(first.sessionId, cards[0].id, "again", now);

      const resumed = await scheduler.startCramSession(deck, cards, now);
      expect(resumed.sessionId).toBe(first.sessionId);
      expect(scheduler.hasUndoableCram(resumed.sessionId)).toBe(false);
      expect(await scheduler.undoLastCramRating(resumed.sessionId)).toBeNull();
      expect((await db.getCramCardById(`${first.sessionId}:${cards[0].id}`))?.reps).toBe(1);
    });
  });
}
