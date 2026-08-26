import { generateFlashcardId } from "../../utils/hash";
import type { IDatabaseService } from "../../index";
import { type ConformanceHost, syncNote, table, testDeck } from "./harness";

/**
 * Renames are recovered exactly — by anchor where a card has one, by identical
 * back where it does not. The front-similarity guess that used to cover the rest
 * is retired: it was capped, and the cap disabled it on exactly the large decks
 * where a rename is most likely.
 */
export function describeRenameDetection(host: ConformanceHost): void {
  describe(`rename detection (${host.label})`, () => {
    let db: IDatabaseService;
    let deckId: string;

    beforeEach(async () => {
      db = await host.open();
      deckId = await db.createDeck(testDeck());
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("identical back: a front rename keeps scheduling state", async () => {
      await syncNote(db, deckId, table([["la maison", "the house"]]));
      await db.updateFlashcard(generateFlashcardId("la maison"), {
        state: "review",
        stability: 7.7,
      });

      await syncNote(db, deckId, table([["la maison!!", "the house"]]));

      const [card] = await db.getFlashcardsByDeck(deckId);
      expect(card.id).toBe(generateFlashcardId("la maison!!"));
      expect(card.state).toBe("review");
      expect(card.stability).toBe(7.7);
    });

    it("both sides edited, unanchored: state is not inherited", async () => {
      await syncNote(db, deckId, table([["le chien noir", "the black dog"]]));
      await db.updateFlashcard(generateFlashcardId("le chien noir"), {
        state: "review",
        stability: 3.3,
      });

      await syncNote(
        db,
        deckId,
        table([["le chien noir!", "the black dog (new wording)"]])
      );

      const [card] = await db.getFlashcardsByDeck(deckId);
      expect(card.id).toBe(generateFlashcardId("le chien noir!"));
      expect(card.stability).not.toBe(3.3);
    });

    it("both sides edited, anchored: state migrates exactly", async () => {
      const row = (front: string, back: string): string =>
        `## T\n\n| Front | Back |\n| --- | --- |\n| ${front} | ${back} %%dk:t:tok1%% |\n`;

      await syncNote(db, deckId, row("le chien noir", "the black dog"));
      const oldId = generateFlashcardId("le chien noir");
      await db.updateFlashcard(oldId, {
        state: "review",
        stability: 3.3,
        repetitions: 3,
        lastReviewed: new Date().toISOString(),
      });

      // Adopt-only: the binding lands when the token meets a card with history.
      await syncNote(db, deckId, row("le chien noir", "the black dog"));
      await syncNote(
        db,
        deckId,
        row("le chien noir!", "the black dog (new wording)")
      );

      const [card] = await db.getFlashcardsByDeck(deckId);
      expect(card.id).toBe(oldId);
      expect(card.stability).toBe(3.3);
    });

    it("an unrelated replacement does not inherit state", async () => {
      await syncNote(db, deckId, table([["cat", "a feline"]]));
      await db.updateFlashcard(generateFlashcardId("cat"), {
        state: "review",
        stability: 9.9,
      });

      await syncNote(
        db,
        deckId,
        table([["a completely different question entirely", "unrelated"]])
      );

      const [card] = await db.getFlashcardsByDeck(deckId);
      expect(card.stability).not.toBe(9.9);
    });
  });
}
