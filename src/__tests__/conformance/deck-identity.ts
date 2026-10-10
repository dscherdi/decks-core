import { generateDeckId } from "../../utils/hash";
import type { IDatabaseService } from "../../index";
import { type ConformanceHost, syncNote, testDeck } from "./harness";

/**
 * Deck ids hash the note's path, so two paths can share one. The deck that holds
 * the id keeps it; the other note is refused rather than taking it over.
 */
export function describeDeckIdentity(host: ConformanceHost): void {
  describe(`deck identity (${host.label})`, () => {
    let db: IDatabaseService;

    beforeEach(async () => {
      db = await host.open();
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("refuses a deck id that another note's deck holds, keeping that deck and its cards", async () => {
      const id = generateDeckId("Deutsch/Küste.md");
      expect(generateDeckId("Deutsch/Paste.md")).toBe(id);
      await db.createDeck(testDeck({ id, filepath: "Deutsch/Küste.md" }));
      await syncNote(db, id, "## Q\n\nA.\n");

      await expect(
        db.createDeck(testDeck({ id, filepath: "Deutsch/Paste.md" }))
      ).rejects.toMatchObject({
        name: "DeckIdCollisionError",
        filepath: "Deutsch/Paste.md",
        heldBy: "Deutsch/Küste.md",
      });
      expect((await db.getDeckById(id))?.filepath).toBe("Deutsch/Küste.md");
      expect(await db.getFlashcardsByDeck(id)).toHaveLength(1);
    });
  });
}
