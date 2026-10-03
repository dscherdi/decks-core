import { generateFlashcardId } from "../../utils/hash";
import { cardIdForKey } from "../../utils/anchors";
import { AnchorStamper } from "../../services/AnchorStamper";
import type { NoteAccess } from "../../services/NoteAccess";
import type { IDatabaseService } from "../../index";
import { type ConformanceHost, syncNote, testDeck } from "./harness";

/** A note held in memory, standing in for whichever vault the surface has. */
function memoryNotes(files: Record<string, string>): NoteAccess {
  return {
    read: async (p) => files[p] ?? null,
    process: async (p, edit) => {
      if (files[p] !== undefined) files[p] = edit(files[p]);
    },
    mtime: async () => 1,
    readProperty: async () => null,
    writeProperty: async () => {},
  };
}

const FRONT = "What is DNA?";
const NOTE = `## ${FRONT}\n\nThe molecule of heredity.\n`;

async function withHistory(db: IDatabaseService, cardId: string): Promise<void> {
  await db.updateFlashcard(cardId, {
    repetitions: 1,
    lastReviewed: new Date().toISOString(),
  });
}

/**
 * A token one surface stamps has to be usable by the other. Bindings live in
 * each device's own database; only the token travels, so it carries the ids.
 */
export function describeAnchorInterop(host: ConformanceHost): void {
  describe(`anchor interop (${host.label})`, () => {
    let db: IDatabaseService;
    let deckId: string;

    beforeEach(async () => {
      db = await host.open();
      deckId = await db.createDeck(testDeck({ filepath: "Bio.md" }));
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("resolves a token another device stamped, with no binding of its own", async () => {
      // The other device's note, already carrying a token it minted.
      const files = { "Bio.md": NOTE };
      const stamper = new AnchorStamper(memoryNotes(files), db);
      await syncNote(db, deckId, files["Bio.md"]);
      const cardId = generateFlashcardId(FRONT);
      await withHistory(db, cardId);
      const stamped = await stamper.ensureAnchored(
        (await db.getFlashcardById(cardId))!
      );
      expect(stamped.ok).toBe(true);
      const token = files["Bio.md"].match(/%%dk:h:([a-z0-9]+)%%/);
      expect(token).not.toBeNull();
      expect(cardIdForKey(`h:${token![1]}`)).toBe(cardId);

      const other = await host.open();
      try {
        const otherDeck = await other.createDeck(testDeck({ filepath: "Bio.md" }));
        await syncNote(other, otherDeck, files["Bio.md"]);
        const [card] = await other.getFlashcardsByDeck(otherDeck);
        expect(card.id).toBe(cardId);
        expect(card.anchor).toBe(`h:${token![1]}`);
        expect(await other.getAnchorBinding(`h:${token![1]}`)).toBeNull();
      } finally {
        await host.close(other);
      }
    });

    it("keeps the card's identity when its wording changes after adoption", async () => {
      const files = { "Bio.md": NOTE };
      const stamper = new AnchorStamper(memoryNotes(files), db);
      await syncNote(db, deckId, files["Bio.md"]);
      const cardId = generateFlashcardId(FRONT);
      await withHistory(db, cardId);
      await stamper.ensureAnchored((await db.getFlashcardById(cardId))!);

      // The edit that would otherwise mint a new id and orphan the history.
      const edited = files["Bio.md"].replace(FRONT, "What is deoxyribonucleic acid?");
      await syncNote(db, deckId, edited);

      const [card] = await db.getFlashcardsByDeck(deckId);
      expect(card.id).toBe(cardId);
      expect(card.front).toBe("What is deoxyribonucleic acid?");
      expect(card.repetitions).toBe(1);
    });
  });
}
