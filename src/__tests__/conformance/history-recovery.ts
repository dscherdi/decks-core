import { generateFlashcardId } from "../../utils/hash";
import { applyOp } from "../../services/SyncLog.handlers";
import type { HistoryRelinkOp, IDatabaseService, ILogger, SyncLogEntry, SyncOpV1 } from "../../index";
import { type ConformanceHost, syncNote, table, testDeck } from "./harness";

const FRONT = "Mitochondria";
const BACK = "The powerhouse of the cell, where respiration happens.";
const NOTE = `## ${FRONT}\n\n${BACK}\n`;
const DEAD = "card_dead1";
const quiet: ILogger = { debug: () => {}, error: () => {} };

async function hashOf(db: IDatabaseService, cardId: string): Promise<string> {
  const rows = await db.querySql<{ content_hash: string }>(
    "SELECT content_hash FROM flashcards WHERE id = ?",
    [cardId],
    { asObject: true }
  );
  return rows[0].content_hash;
}

async function logCount(db: IDatabaseService, flashcardId: string): Promise<number> {
  const rows = await db.querySql<{ n: number }>(
    "SELECT COUNT(*) AS n FROM review_logs WHERE flashcard_id = ?",
    [flashcardId],
    { asObject: true }
  );
  return rows[0]?.n ?? 0;
}

async function review(
  db: IDatabaseService,
  flashcardId: string,
  contentHash: string | undefined,
  reviewedAt: string
): Promise<void> {
  await db.createReviewLog({
    flashcardId,
    lastReviewedAt: reviewedAt,
    reviewedAt,
    rating: 3,
    ratingLabel: "good",
    oldState: "new",
    oldRepetitions: 0,
    oldLapses: 0,
    oldStability: 0,
    oldDifficulty: 5,
    newState: "review",
    newRepetitions: 1,
    newLapses: 0,
    newStability: 3,
    newDifficulty: 5,
    oldIntervalMinutes: 0,
    newIntervalMinutes: 4320,
    oldDueAt: reviewedAt,
    newDueAt: reviewedAt,
    elapsedDays: 0,
    retrievability: 1,
    requestRetention: 0.9,
    profile: "STANDARD",
    maximumIntervalDays: 36500,
    minMinutes: 1,
    fsrsWeightsVersion: "test",
    schedulerVersion: "test",
    contentHash,
  });
}

function entry(op: SyncOpV1, at: string): SyncLogEntry {
  return { hlc: [Date.parse(at), 0, "remote-dev"], s: 1, v: 1, ...op } as SyncLogEntry;
}

function relinkEntry(from: string, c: string, at: string): SyncLogEntry {
  return entry({ o: "history_relink", p: { links: [{ from, c }], at } }, at);
}

/**
 * Review history left under an id no card has any more goes back to the one card
 * with the same content, and the move reaches other devices as an op.
 */
export function describeHistoryRecovery(host: ConformanceHost): void {
  describe(`review history recovery (${host.label})`, () => {
    let db: IDatabaseService;
    let deckId: string;
    let cardId: string;
    let hash: string;

    beforeEach(async () => {
      db = await host.open();
      deckId = await db.createDeck(testDeck({ filepath: "Bio.md" }));
      await syncNote(db, deckId, NOTE);
      cardId = generateFlashcardId(FRONT);
      hash = await hashOf(db, cardId);
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("re-attaches stranded history to the one card with the same content", async () => {
      await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");
      await review(db, DEAD, hash, "2026-09-05T10:00:00.000Z");

      const result = await db.recoverReviewHistory();

      expect(result.reattached).toBe(1);
      expect(result.restored).toBe(1);
      expect(await logCount(db, cardId)).toBe(2);
      expect(await logCount(db, DEAD)).toBe(0);
      const card = await db.getFlashcardById(cardId);
      expect(card?.state).toBe("review");
      expect(card?.lastReviewed).toBe("2026-09-05T10:00:00.000Z");
    });

    it("leaves history alone when two cards share its content", async () => {
      const other = await db.createDeck(testDeck({ id: "deck_other", filepath: "Other.md" }));
      await syncNote(db, other, `## Another front\n\n${BACK}\n`);
      await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");

      const result = await db.recoverReviewHistory();

      expect(result.reattached).toBe(0);
      expect(result.plan.skipped).toEqual([{ from: DEAD, reason: "ambiguous" }]);
      expect(await logCount(db, DEAD)).toBe(1);
    });

    it("leaves history alone under an id of another kind", async () => {
      await review(db, "zz_dead1", hash, "2026-09-01T10:00:00.000Z");

      expect((await db.recoverReviewHistory()).reattached).toBe(0);
      expect(await logCount(db, "zz_dead1")).toBe(1);
    });

    it("leaves history alone when its reviews carry no usable content hash", async () => {
      await review(db, "card_dead1", undefined, "2026-09-01T10:00:00.000Z");
      await review(db, "card_dead2", "", "2026-09-01T10:00:00.000Z");
      await review(db, "card_dead3", "0", "2026-09-01T10:00:00.000Z");

      expect((await db.recoverReviewHistory()).reattached).toBe(0);
      expect(await logCount(db, cardId)).toBe(0);
    });

    it("leaves history alone when the matching card's answer is short", async () => {
      await syncNote(db, deckId, "## Q\n\nShort.\n");
      const short = generateFlashcardId("Q");
      await review(db, DEAD, await hashOf(db, short), "2026-09-01T10:00:00.000Z");

      const result = await db.recoverReviewHistory();

      expect(result.reattached).toBe(0);
      expect(result.plan.skipped).toEqual([{ from: DEAD, reason: "short-content" }]);
    });

    it("re-attaches history to a table row with a short answer", async () => {
      const tableDeck = await db.createDeck(testDeck({ id: "deck_table", filepath: "Table.md" }));
      await syncNote(db, tableDeck, table([["Hund", "dog"]]));
      const [row] = await db.getFlashcardsByDeck(tableDeck);
      await review(db, DEAD, await hashOf(db, row.id), "2026-09-01T10:00:00.000Z");

      expect((await db.recoverReviewHistory()).reattached).toBe(1);
      expect(await logCount(db, row.id)).toBe(1);
    });

    it("leaves history alone when it overlaps the card's own reviews", async () => {
      await review(db, cardId, hash, "2026-09-03T10:00:00.000Z");
      await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");
      await review(db, DEAD, hash, "2026-09-05T10:00:00.000Z");

      const result = await db.recoverReviewHistory();

      expect(result.reattached).toBe(0);
      expect(result.plan.skipped).toEqual([{ from: DEAD, reason: "interleaved" }]);
    });

    it("keeps a learned card's newer scheduling when older history joins it", async () => {
      await review(db, cardId, hash, "2026-09-10T10:00:00.000Z");
      await db.executeSql(
        "UPDATE flashcards SET state = 'review', interval = 999, last_reviewed = ? WHERE id = ?",
        ["2026-09-10T10:00:00.000Z", cardId]
      );
      await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");

      expect((await db.recoverReviewHistory()).reattached).toBe(1);

      const card = await db.getFlashcardById(cardId);
      expect(card?.interval).toBe(999);
      expect(card?.lastReviewed).toBe("2026-09-10T10:00:00.000Z");
      expect(await logCount(db, cardId)).toBe(2);
    });

    it("moves the card's suspension and custom-deck membership with its history", async () => {
      const suspendedAt = "2026-09-02T10:00:00.000Z";
      await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");
      await db.executeSql(
        "INSERT INTO card_state_overlays (flashcard_id, suspended_at, buried_until, modified) VALUES (?, ?, NULL, ?)",
        [DEAD, suspendedAt, suspendedAt]
      );
      const custom = await db.createCustomDeck("Exam");
      // Membership left behind by a card gone while foreign keys were off.
      const [fk] = await db.querySql<{ foreign_keys: number }>("PRAGMA foreign_keys", [], { asObject: true });
      await db.executeSql("PRAGMA foreign_keys = OFF");
      await db.executeSql(
        "INSERT INTO custom_deck_cards (id, custom_deck_id, flashcard_id, created) VALUES (?, ?, ?, ?)",
        ["ccd_dead1", custom, DEAD, suspendedAt]
      );
      await db.executeSql(`PRAGMA foreign_keys = ${fk?.foreign_keys ? "ON" : "OFF"}`);

      await db.recoverReviewHistory();

      expect((await db.getFlashcardById(cardId))?.suspendedAt).toBe(suspendedAt);
      expect(await db.getFlashcardIdsForCustomDeck(custom)).toEqual([cardId]);
    });

    it("changes nothing when run again", async () => {
      await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");
      await db.recoverReviewHistory();

      const again = await db.recoverReviewHistory();

      expect(again.reattached).toBe(0);
      expect(again.restored).toBe(0);
      expect(await logCount(db, cardId)).toBe(1);
    });

    it("writes the moves to the sync log, and the legacy rebuild writes nothing", async () => {
      const ops: SyncOpV1[] = [];
      db.setSyncLog({ append: (op) => ops.push(op) });
      await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");

      await db.rebuildCardStateFromReviewLogs();
      expect(ops.filter((op) => op.o === "history_relink")).toEqual([]);

      await db.recoverReviewHistory();
      const relinks = ops.filter((op): op is HistoryRelinkOp => op.o === "history_relink");
      expect(relinks).toHaveLength(1);
      expect(relinks[0].p.links).toEqual([{ from: DEAD, c: cardId }]);
    });

    describe("history_relink from another device", () => {
      it("moves the stranded history and schedules the card from it", async () => {
        await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");

        await applyOp(db, "remote-dev", relinkEntry(DEAD, cardId, "2026-10-01T10:00:00.000Z"), quiet);

        expect(await logCount(db, cardId)).toBe(1);
        expect((await db.getFlashcardById(cardId))?.state).toBe("review");
      });

      it("never takes a live card's history", async () => {
        await syncNote(db, deckId, `${NOTE}\n## Ribosome\n\nWhere proteins are made in the cell.\n`);
        const live = generateFlashcardId("Ribosome");
        await review(db, live, await hashOf(db, live), "2026-09-01T10:00:00.000Z");

        await applyOp(db, "remote-dev", relinkEntry(live, cardId, "2026-10-01T10:00:00.000Z"), quiet);

        expect(await logCount(db, live)).toBe(1);
        expect(await logCount(db, cardId)).toBe(0);
      });

      it("changes nothing when replayed and never moves the card's modified time back", async () => {
        const later = "2030-01-01T00:00:00.000Z";
        await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");
        await db.executeSql("UPDATE flashcards SET modified = ? WHERE id = ?", [later, cardId]);
        const op = relinkEntry(DEAD, cardId, "2026-10-01T10:00:00.000Z");

        await applyOp(db, "remote-dev", op, quiet);
        await applyOp(db, "remote-dev", op, quiet);

        expect(await logCount(db, cardId)).toBe(1);
        expect((await db.getFlashcardById(cardId))?.modified).toBe(later);
      });

      it("restores a card created after the relink arrived", async () => {
        const fresh = await host.open();
        try {
          const freshDeck = await fresh.createDeck(testDeck({ filepath: "Bio.md" }));
          await review(fresh, DEAD, hash, "2026-09-01T10:00:00.000Z");

          await applyOp(fresh, "remote-dev", relinkEntry(DEAD, cardId, "2026-10-01T10:00:00.000Z"), quiet);
          await syncNote(fresh, freshDeck, NOTE);

          expect(await logCount(fresh, cardId)).toBe(1);
          expect((await fresh.getFlashcardById(cardId))?.state).toBe("review");
        } finally {
          await host.close(fresh);
        }
      });
    });

    describe("resets", () => {
      it("a reset card does not get stranded history back", async () => {
        await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");

        await db.resetCard(cardId);

        expect((await db.recoverReviewHistory()).reattached).toBe(0);
        expect(await logCount(db, DEAD)).toBe(0);
        expect((await db.getFlashcardById(cardId))?.state).toBe("new");
      });

      it("a card reset after its history was re-attached stays new", async () => {
        await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");
        await db.recoverReviewHistory();

        await db.resetCard(cardId);
        await db.recoverReviewHistory();

        expect(await logCount(db, cardId)).toBe(0);
        expect((await db.getFlashcardById(cardId))?.state).toBe("new");
      });

      it("a deck reset forgets the stranded history of its cards", async () => {
        await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");

        await db.resetDeckProgress(deckId);

        expect(await logCount(db, DEAD)).toBe(0);
      });

      it("a reset from another device that arrives before the relink keeps the card new", async () => {
        const resetAt = new Date(Date.now() + 60_000).toISOString();
        await review(db, DEAD, hash, "2026-09-01T10:00:00.000Z");

        await applyOp(db, "remote-dev", entry({ o: "card_reset", p: { c: cardId, at: resetAt } }, resetAt), quiet);
        await applyOp(db, "remote-dev", relinkEntry(DEAD, cardId, "2026-10-01T10:00:00.000Z"), quiet);

        expect(await logCount(db, cardId)).toBe(0);
        expect((await db.getFlashcardById(cardId))?.state).toBe("new");
      });
    });
  });
}
