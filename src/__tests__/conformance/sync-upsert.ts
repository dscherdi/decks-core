import { generateDeckId, generateFlashcardId } from "../../utils/hash";
import type { Deck, IDatabaseService } from "../../index";
import { type ConformanceHost, syncNote } from "./harness";

/**
 * The sync create op is a move-or-create upsert. An ORPHANED card (its deck row
 * is gone) is adopted into the new deck with content refreshed and scheduling /
 * suspend / bury state preserved, which makes re-import into a dirty vault
 * lossless. A card that still lives in a LIVE deck is never stolen — otherwise a
 * front shared by overlapping decks would bounce on every sync.
 */
export function describeSyncUpsert(host: ConformanceHost): void {
  describe(`sync upsert (${host.label})`, () => {
    let db: IDatabaseService;

    const CONTENT =
      "## Topic\n\n| Front | Back |\n| --- | --- |\n| Capital of France | Paris |\n";
    const cardId = generateFlashcardId("Capital of France");

    async function makeDeck(name: string): Promise<Deck> {
      const filepath = `/test/${name}.md`;
      const id = generateDeckId(filepath);
      await db.createDeck({
        id,
        name,
        filepath,
        tag: "decks/test",
        lastReviewed: null,
      } as Omit<Deck, "created" | "modified" | "profileId">);
      return (await db.getDeckById(id)) as Deck;
    }

    // Orphan a card the way FK-off migrations did: drop the deck row, no cascade.
    async function orphanCardsOf(deck: Deck): Promise<void> {
      await db.executeSql("PRAGMA foreign_keys = OFF", []);
      await db.executeSql("DELETE FROM decks WHERE id = ?", [deck.id]);
      await db.executeSql("PRAGMA foreign_keys = ON", []);
    }

    beforeEach(async () => {
      db = await host.open();
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("does not steal a card that still lives in a live deck", async () => {
      const a = await makeDeck("deck-a");
      const b = await makeDeck("deck-b");
      await syncNote(db, a.id, CONTENT);
      const suspendedAt = new Date().toISOString();
      await db.updateFlashcard(cardId, {
        state: "review",
        stability: 9.9,
        suspendedAt,
      });

      await syncNote(db, b.id, CONTENT);

      expect(await db.getFlashcardsByDeck(b.id)).toHaveLength(0);
      const inA = await db.getFlashcardsByDeck(a.id);
      expect(inA.map((c) => c.id)).toEqual([cardId]);
      expect(inA[0].state).toBe("review");
      expect(inA[0].stability).toBe(9.9);
      expect(inA[0].suspendedAt).toBe(suspendedAt);
      expect(await db.countAllCards()).toBe(1);
    });

    it("adopts an orphaned card, preserving all state", async () => {
      const tmp = await makeDeck("deck-tmp");
      await syncNote(db, tmp.id, CONTENT);
      const buriedUntil = new Date(Date.now() + 86_400_000).toISOString();
      await db.updateFlashcard(cardId, {
        state: "review",
        stability: 12.3,
        buriedUntil,
      });
      await orphanCardsOf(tmp);

      const b = await makeDeck("deck-b");
      await syncNote(db, b.id, CONTENT);

      const inB = await db.getFlashcardsByDeck(b.id);
      expect(inB.map((c) => c.id)).toEqual([cardId]);
      expect(inB[0].state).toBe("review");
      expect(inB[0].stability).toBe(12.3);
      expect(inB[0].buriedUntil).toBe(buriedUntil);
      expect(await db.countAllCards()).toBe(1);
      expect(await db.pruneOrphanedFlashcards()).toBe(0);
    });

    it("prunes only dangling orphans, keeping live cards", async () => {
      const b = await makeDeck("deck-b");
      await syncNote(db, b.id, CONTENT);

      const orphan = await makeDeck("deck-orphan");
      await syncNote(
        db,
        orphan.id,
        "## T\n\n| Front | Back |\n| --- | --- |\n| Zzz | zzz |\n"
      );
      await orphanCardsOf(orphan);
      expect(await db.countAllCards()).toBe(2);

      expect(await db.pruneOrphanedFlashcards()).toBe(1);
      expect(await db.countAllCards()).toBe(1);
      expect((await db.getFlashcardsByDeck(b.id)).map((c) => c.id)).toEqual([
        cardId,
      ]);
    });

    it("an empty read does not wipe the deck, but a real edit does", async () => {
      const a = await makeDeck("deck-a");
      await syncNote(db, a.id, CONTENT);
      expect(await db.getFlashcardsByDeck(a.id)).toHaveLength(1);

      const call = async (fileContent: string) => {
        const deck = await db.getDeckWithProfile(a.id);
        return db.syncFlashcardsForDeck({
          deckId: a.id,
          deckName: a.name,
          deckFilepath: a.filepath,
          deckConfig: deck!.profile,
          fileContent,
        });
      };

      // A failed or racy read of a live deck file must not delete its cards.
      const empty = await call("   \n");
      expect(empty.skippedEmptyParse).toBe(true);
      expect(await db.getFlashcardsByDeck(a.id)).toHaveLength(1);

      // Content that genuinely has no cards is a real edit, and deletes.
      const noCards = await call("Just some prose, no cards.\n");
      expect(noCards.skippedEmptyParse).toBeFalsy();
      expect(await db.getFlashcardsByDeck(a.id)).toHaveLength(0);
    });
  });
}
