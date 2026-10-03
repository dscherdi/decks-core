import type { Flashcard } from "../../database/types";
import { encodeAnchorValue } from "../../utils/anchors";
import { generateFlashcardId, generateReverseFlashcardId } from "../../utils/hash";
import { noteCardGroups, noteCardOf } from "../ReverseCards";

function card(id: string, front: string, back: string, extra: Partial<Flashcard> = {}): Flashcard {
  return {
    id,
    deckId: "deck_1",
    front,
    back,
    type: "header-paragraph",
    sourceFile: "Words.md",
    contentHash: "hash",
    breadcrumb: "",
    notes: "",
    clozeText: null,
    clozeOrder: null,
    anchor: null,
    state: "review",
    dueDate: "2026-01-15T12:00:00.000Z",
    interval: 1440,
    repetitions: 1,
    difficulty: 5,
    stability: 1,
    lapses: 0,
    lastReviewed: null,
    created: "2026-01-15T12:00:00.000Z",
    modified: "2026-01-15T12:00:00.000Z",
    ...extra,
  };
}

// The reverse row the sync writes for a note card: sides swapped, the token key plus ":rev".
function reverseOf(note: Flashcard, front: string): Flashcard {
  return card(generateReverseFlashcardId(front), note.back, note.front, {
    deckId: note.deckId,
    anchor: note.anchor ? `${note.anchor}:rev` : null,
  });
}

function value(kind: "a" | "b", ids: string[]): string {
  const encoded = encodeAnchorValue(kind, ids);
  if (encoded === null) throw new Error(`cannot encode ${ids.join(",")}`);
  return encoded;
}

function dbOf(rows: Flashcard[]) {
  const scanned: string[] = [];
  return {
    scanned,
    db: {
      getFlashcardById: async (id: string) => rows.find((r) => r.id === id) ?? null,
      getFlashcardsByDeck: async (deckId: string) => {
        scanned.push(deckId);
        return rows.filter((r) => r.deckId === deckId);
      },
    },
  };
}

describe("noteCardOf", () => {
  it("is the card itself for a card that is not reversed", async () => {
    const hund = card(generateFlashcardId("Hund"), "Hund", "dog");
    expect(await noteCardOf(dbOf([]).db, hund)).toBe(hund);
  });

  it("finds an unstamped note card by its content id, without reading the deck", async () => {
    const hund = card(generateFlashcardId("Hund"), "Hund", "dog");
    const { db, scanned } = dbOf([hund]);
    expect(await noteCardOf(db, reverseOf(hund, "Hund"))).toBe(hund);
    expect(scanned).toEqual([]);
  });

  it("follows the note's token after its heading was edited", async () => {
    const id = generateFlashcardId("Hund");
    const token = `h:${value("b", [id, generateReverseFlashcardId("Hund")])}`;
    const hund = card(id, "Hund (m)", "dog", { anchor: token });
    const { db, scanned } = dbOf([hund]);
    expect(await noteCardOf(db, reverseOf(hund, "Hund"))).toBe(hund);
    expect(scanned).toEqual([]);
  });

  it("finds a copied block's own note card, not the card whose token it copied", async () => {
    const token = `h:${value("a", [generateFlashcardId("Hund")])}`;
    const hund = card(generateFlashcardId("Hund"), "Hund", "dog", { anchor: token });
    const katze = card(generateFlashcardId("Katze"), "Katze", "cat");
    // The copy loses the token; its reverse row still carries it.
    const copiedReverse = card(generateReverseFlashcardId("Katze"), "cat", "Katze", {
      anchor: `${token}:rev`,
    });
    expect(await noteCardOf(dbOf([hund, katze]).db, copiedReverse)).toBe(katze);
  });

  it("reads the deck when only a binding knows the note card's id", async () => {
    const hund = card("card_bound1", "Hund (m)", "dog", { anchor: "h:k3j2l1" });
    const { db, scanned } = dbOf([hund]);
    expect(await noteCardOf(db, reverseOf(hund, "Hund"))).toBe(hund);
    expect(scanned).toEqual(["deck_1"]);
  });

  it("tells a mirrored pair apart", async () => {
    const ab = card(generateFlashcardId("A"), "A", "B", { type: "table" });
    const ba = card(generateFlashcardId("B"), "B", "A", { type: "table" });
    const { db } = dbOf([ab, ba]);
    expect(await noteCardOf(db, reverseOf(ab, "A"))).toBe(ab);
    expect(await noteCardOf(db, reverseOf(ba, "B"))).toBe(ba);
  });

  it("is null when the note card is gone, even if another deck has its heading", async () => {
    const elsewhere = card(generateFlashcardId("Hund"), "Hund", "dog", { deckId: "deck_2" });
    const reverse = card(generateReverseFlashcardId("Hund"), "dog", "Hund");
    expect(await noteCardOf(dbOf([elsewhere]).db, reverse)).toBeNull();
  });
});

describe("noteCardGroups", () => {
  const ids = (groups: ReturnType<typeof noteCardGroups>) =>
    groups.map((g) => [g.card.id, g.rows.map((r) => r.id)]);

  it("puts a reverse card with its note card, wherever either comes in the list", () => {
    const hund = card(generateFlashcardId("Hund"), "Hund", "dog");
    const katze = card(generateFlashcardId("Katze"), "Katze", "cat");
    const hundBack = reverseOf(hund, "Hund");
    expect(ids(noteCardGroups([hundBack, katze, hund]))).toEqual([
      [hund.id, [hund.id, hundBack.id]],
      [katze.id, [katze.id]],
    ]);
  });

  it("keeps a mirrored pair apart, and a reverse card whose note card is not given on its own", () => {
    const ab = card(generateFlashcardId("A"), "A", "B");
    const ba = card(generateFlashcardId("B"), "B", "A");
    const abBack = reverseOf(ab, "A");
    const orphan = card(generateReverseFlashcardId("Gone"), "Lost answer", "Gone");
    const elsewhere = { ...reverseOf(ab, "A"), deckId: "deck_2" };
    expect(ids(noteCardGroups([ab, ba, abBack, orphan, elsewhere]))).toEqual([
      [ab.id, [ab.id, abBack.id]],
      [ba.id, [ba.id]],
      [orphan.id, [orphan.id]],
      [elsewhere.id, [elsewhere.id]],
    ]);
  });

  it("pairs a copied note's reverse card with the copy, not with the note whose token it carries", () => {
    // The original keeps its token's ids after a heading edit; the pasted copy falls back to content ids.
    const token = `h:${value("b", [generateFlashcardId("Hund"), generateReverseFlashcardId("Hund")])}`;
    const original = card(generateFlashcardId("Hund"), "Hund (m)", "dog", { anchor: token });
    const originalBack = card(generateReverseFlashcardId("Hund"), "dog", "Hund (m)", { anchor: `${token}:rev` });
    const copy = card(generateFlashcardId("Hund (m)"), "Hund (m)", "dog");
    const copyBack = card(generateReverseFlashcardId("Hund (m)"), "dog", "Hund (m)");
    expect(ids(noteCardGroups([copy, original, copyBack, originalBack]))).toEqual([
      [copy.id, [copy.id, copyBack.id]],
      [original.id, [original.id, originalBack.id]],
    ]);
  });
});

