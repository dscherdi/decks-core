import {
  generateClozeFlashcardId,
  generateFlashcardId,
  generateReverseFlashcardId,
} from "../../utils/hash";
import { encodeAnchorValue, type AnchorValueKind } from "../../utils/anchors";
import { AnchorStamper } from "../../services/AnchorStamper";
import { AnchorUpgrader } from "../../services/AnchorUpgrader";
import type { NoteAccess } from "../../services/NoteAccess";
import type { DeckProfile, IDatabaseService, SyncResult } from "../../index";
import { type ConformanceHost, syncNote, testDeck } from "./harness";

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

function value(kind: AnchorValueKind, ids: (string | null)[]): string {
  const encoded = encodeAnchorValue(kind, ids);
  if (encoded === null) throw new Error(`cannot encode ${ids.join(",")}`);
  return encoded;
}

async function sync(
  db: IDatabaseService,
  deckId: string,
  fileContent: string,
  extra: { reverseCards?: boolean; clozeEnabled?: boolean } = {}
): Promise<SyncResult> {
  const deck = await db.getDeckWithProfile(deckId);
  if (!deck) throw new Error(`no deck ${deckId}`);
  return db.syncFlashcardsForDeck({
    deckId,
    deckName: deck.name,
    deckFilepath: deck.filepath,
    deckConfig: deck.profile as DeckProfile,
    fileContent,
    ...extra,
  });
}

async function addReview(db: IDatabaseService, flashcardId: string, reviewedAt: string): Promise<void> {
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
  });
}

async function logIds(db: IDatabaseService, flashcardId: string): Promise<number> {
  const rows = await db.querySql<{ n: number }>(
    "SELECT COUNT(*) AS n FROM review_logs WHERE flashcard_id = ?",
    [flashcardId],
    { asObject: true }
  );
  return rows[0]?.n ?? 0;
}

/**
 * A stamped token carries the ids of the cards on its host, so any device
 * resolves them from the note alone.
 */
export function describeCardIdentity(host: ConformanceHost): void {
  describe(`card identity (${host.label})`, () => {
    let db: IDatabaseService;
    let deckId: string;

    beforeEach(async () => {
      db = await host.open();
      deckId = await db.createDeck(testDeck({ filepath: "Bio.md" }));
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("resolves an edited card to its id on a device that never saw another database", async () => {
      const front = "What is DNA?";
      const files = { "Bio.md": `## ${front}\n\nThe molecule of heredity.\n` };
      await syncNote(db, deckId, files["Bio.md"]);
      const cardId = generateFlashcardId(front);
      await new AnchorStamper(memoryNotes(files), db).ensureAnchored(
        (await db.getFlashcardById(cardId))!
      );

      const fresh = await host.open();
      try {
        const freshDeck = await fresh.createDeck(testDeck({ filepath: "Bio.md" }));
        const edited = files["Bio.md"]
          .replace(front, "What is deoxyribonucleic acid?")
          .replace("The molecule of heredity.", "The hereditary molecule.");
        await syncNote(fresh, freshDeck, edited);

        const [card] = await fresh.getFlashcardsByDeck(freshDeck);
        expect(card.id).toBe(cardId);
        expect(card.front).toBe("What is deoxyribonucleic acid?");
        const bindings = await fresh.querySql<{ n: number }>(
          "SELECT COUNT(*) AS n FROM anchor_bindings",
          [],
          { asObject: true }
        );
        expect(bindings[0].n).toBe(0);
      } finally {
        await host.close(fresh);
      }
    });

    it("keeps each deletion's id when the line is edited, not counting code spans", async () => {
      const alpha = generateClozeFlashcardId("Syntax", "alpha", 0);
      const beta = generateClozeFlashcardId("Syntax", "beta", 1);
      const token = `%%dk:c:${value("p", [alpha, beta])}%%`;
      const note = (a: string, b: string): string =>
        `## Syntax\n\nUse \`==x==\` with ==${a}== then ==${b}==. ${token}\n`;
      await sync(db, deckId, note("alpha", "beta"), { clozeEnabled: true });
      await sync(db, deckId, note("alpha two", "beta two"), { clozeEnabled: true });

      const cards = await db.getFlashcardsByDeck(deckId);
      const byText = new Map(cards.map((c) => [c.clozeText, c.id]));
      expect(byText.get("alpha two")).toBe(alpha);
      expect(byText.get("beta two")).toBe(beta);
      expect(cards).toHaveLength(2);
    });

    it("leaves a deletion without a slot on its content id", async () => {
      const alpha = generateClozeFlashcardId("Q", "alpha", 0);
      const note = `## Q\n\n==alpha== and ==added== %%dk:c:${value("p", [alpha])}%%\n`;
      await sync(db, deckId, note, { clozeEnabled: true });

      const ids = (await db.getFlashcardsByDeck(deckId)).map((c) => c.id).sort();
      expect(ids).toEqual([alpha, generateClozeFlashcardId("Q", "added", 1)].sort());
    });

    it("carries a reverse card's id beside its forward card's", async () => {
      const forward = generateFlashcardId("Sun");
      const reverse = generateReverseFlashcardId("Sun");
      const token = `%%dk:h:${value("b", [forward, reverse])}%%`;
      await sync(db, deckId, `## Moon\n\nNight light.\n${token}\n`, { reverseCards: true });

      const ids = (await db.getFlashcardsByDeck(deckId)).map((c) => c.id).sort();
      expect(ids).toEqual([forward, reverse].sort());
    });

    it("gives the later of two hosts carrying the same token its own id", async () => {
      const first = generateFlashcardId("One");
      const token = `%%dk:h:${value("a", [first])}%%`;
      await sync(db, deckId, `## One\n\nFirst.\n${token}\n\n## Two\n\nSecond.\n${token}\n`);

      const cards = await db.getFlashcardsByDeck(deckId);
      expect(cards.map((c) => c.id).sort()).toEqual([first, generateFlashcardId("Two")].sort());
      expect(cards.find((c) => c.front === "Two")?.anchor).toBeNull();
    });

    it("leaves `modified` alone when only the token changes", async () => {
      const note = "## Q\n\nA.\n";
      await sync(db, deckId, note);
      const id = generateFlashcardId("Q");
      await db.executeSql("UPDATE flashcards SET modified = ? WHERE id = ?", [
        "2020-01-01T00:00:00.000Z",
        id,
      ]);

      await sync(db, deckId, `${note}%%dk:h:${value("a", [id])}%%\n`);

      const card = await db.getFlashcardById(id);
      expect(card?.anchor).toBe(`h:${value("a", [id])}`);
      expect(card?.modified).toBe("2020-01-01T00:00:00.000Z");
    });

    it("merges a card into the id its token now carries, history and all", async () => {
      const note = "## Q\n\nA.\n";
      await sync(db, deckId, note);
      const local = generateFlashcardId("Q");
      await addReview(db, local, "2026-01-01T00:00:00.000Z");
      const listId = await db.createCustomDeck("Picked");
      await db.addCardsToCustomDeck(listId, [local]);

      // Another device pinned this card under a different id.
      const pinned = "card_zz9";
      await addReview(db, pinned, "2026-02-01T00:00:00.000Z");
      await sync(db, deckId, `${note}%%dk:h:${value("a", [pinned])}%%\n`);

      const cards = await db.getFlashcardsByDeck(deckId);
      expect(cards.map((c) => c.id)).toEqual([pinned]);
      expect(await logIds(db, pinned)).toBe(2);
      expect(await logIds(db, local)).toBe(0);
      expect(cards[0].lastReviewed).toBe("2026-02-01T00:00:00.000Z");
      expect(await db.getFlashcardIdsForCustomDeck(listId)).toEqual([pinned]);
    });

    it("upgrades a minted token to the id its binding names, which a fresh device then keeps", async () => {
      const original = generateFlashcardId("Q");
      await db.insertAnchorBindings([{ anchor: "h:abc", flashcardId: original }]);
      // Bound before the front was edited, so the card's id is no longer its content id.
      const files = { "Bio.md": "## Q edited\n\nA.\n%%dk:h:abc%%\n" };
      await syncNote(db, deckId, files["Bio.md"]);
      expect(await AnchorUpgrader.pendingCount(db)).toBe(1);

      const notes = memoryNotes(files);
      const upgrader = new AnchorUpgrader(notes, db, new AnchorStamper(notes, db));
      const upgraded = await upgrader.runBatch(
        [{ id: deckId, filepath: "Bio.md", titleMode: false }],
        5,
        () => true
      );

      expect(upgraded).toBe(1);
      expect(files["Bio.md"]).toBe(`## Q edited\n\nA.\n%%dk:h:${value("a", [original])}%%\n`);
      expect(await AnchorUpgrader.pendingCount(db)).toBe(0);
      const fresh = await host.open();
      try {
        const freshDeck = await fresh.createDeck(testDeck({ filepath: "Bio.md" }));
        await syncNote(fresh, freshDeck, files["Bio.md"]);
        expect((await fresh.getFlashcardsByDeck(freshDeck)).map((c) => c.id)).toEqual([original]);
      } finally {
        await host.close(fresh);
      }
    });

    it("reports different cards whose content ids collide", async () => {
      // "Aa" and "BB" hash alike under the 31-bit content hash.
      expect(generateFlashcardId("Aa")).toBe(generateFlashcardId("BB"));
      const result = await sync(db, deckId, "## Aa\n\nFirst.\n\n## BB\n\nSecond.\n");

      expect(result.idCollisions).toEqual([
        { id: generateFlashcardId("Aa"), fronts: ["Aa", "BB"] },
      ]);
    });

    it("does not report the same card written twice as a collision", async () => {
      const result = await sync(db, deckId, "## Q\n\nA.\n\n## Q\n\nA.\n");
      expect(result.duplicatesSkipped).toBe(1);
      expect(result.idCollisions).toBeUndefined();
    });
  });
}
