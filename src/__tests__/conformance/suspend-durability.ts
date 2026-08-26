import { generateFlashcardId } from "../../utils/hash";
import type { IDatabaseService } from "../../index";
import { type ConformanceHost, syncNote, testDeck } from "./harness";

/**
 * Suspend and bury live in `card_state_overlays`, keyed independently of the
 * flashcard row. That is what lets the state survive the card being deleted and
 * re-parsed from the note — a cycle that happens on any edit, and on every
 * migration that rebuilds the table.
 */
export function describeSuspendDurability(host: ConformanceHost): void {
  describe(`suspend/bury durability (${host.label})`, () => {
    const FRONT = "What is the capital of France?";
    const CONTENT = `## ${FRONT}\n\nParis.\n`;

    let db: IDatabaseService;
    let deckId: string;
    let cardId: string;

    beforeEach(async () => {
      db = await host.open();
      deckId = await db.createDeck(testDeck({ filepath: "/test/durability.md" }));
      await syncNote(db, deckId, CONTENT);
      cardId = generateFlashcardId(FRONT);
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("a deleted suspended card is recreated suspended", async () => {
      await db.suspendCard(cardId);
      const suspendedAt = (await db.getFlashcardById(cardId))?.suspendedAt;
      expect(suspendedAt).not.toBeNull();

      await db.executeSql("DELETE FROM flashcards WHERE id = ?", [cardId]);
      await syncNote(db, deckId, CONTENT);

      const recreated = await db.getFlashcardById(cardId);
      expect(recreated).not.toBeNull();
      expect(recreated?.suspendedAt).toBe(suspendedAt);
    });

    it("a deleted buried card is recreated buried", async () => {
      const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await db.buryCard(cardId, until);

      await db.executeSql("DELETE FROM flashcards WHERE id = ?", [cardId]);
      await syncNote(db, deckId, CONTENT);

      expect((await db.getFlashcardById(cardId))?.buriedUntil).toBe(until);
    });

    it("unsuspending also survives delete and re-sync", async () => {
      await db.suspendCard(cardId);
      await db.unsuspendCard(cardId);

      await db.executeSql("DELETE FROM flashcards WHERE id = ?", [cardId]);
      await syncNote(db, deckId, CONTENT);

      expect((await db.getFlashcardById(cardId))?.suspendedAt).toBeNull();
    });
  });
}
