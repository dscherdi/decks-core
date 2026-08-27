import { generateFlashcardId } from "../../utils/hash";
import { headerBindingKey } from "../../utils/anchors";
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
 * A token one surface stamps has to be usable by the other.
 *
 * The app mints anchors now, and its bindings do not travel — they live in its
 * own database. What travels is the token, because it is written into the note.
 * The other surface is supposed to re-derive the binding from it through the
 * adopt rule. Nothing tested that, and it is the seam that decides whether a
 * card keeps its identity across devices.
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

    it("adopts a token another device stamped, once the card has history", async () => {
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

      // This device: same note, same content-derived id, no binding of its own.
      const other = await host.open();
      try {
        const otherDeck = await other.createDeck(testDeck({ filepath: "Bio.md" }));
        await syncNote(other, otherDeck, files["Bio.md"]);
        expect(await other.getAnchorBinding(headerBindingKey(token![1]))).toBeNull();

        // Its review history arrives — a rate op replayed from the sync log —
        // and only then may a binding be adopted.
        await withHistory(other, cardId);
        await syncNote(other, otherDeck, files["Bio.md"]);

        expect(await other.getAnchorBinding(headerBindingKey(token![1]))).toBe(
          cardId
        );
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
