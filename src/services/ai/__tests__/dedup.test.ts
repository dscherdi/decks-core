import { generatedCardId, heldByOtherDecks, partitionAgainstDeck } from "../dedup";
import { generateFlashcardId } from "../../../utils/hash";
import type { GeneratedCard } from "../generation-prompt";
import type { Flashcard } from "../../../database/types";

const card = (front: string, back = "a"): GeneratedCard => ({
  front,
  back,
  notes: "",
});

describe("generatedCardId", () => {
  it("is the same identity the rest of Decks uses for that front", () => {
    // If these ever diverge, a card gets dropped as a duplicate here and then
    // written as a distinct row by the sync layer anyway.
    expect(generatedCardId(card("What is the median?"))).toBe(
      generateFlashcardId("What is the median?"),
    );
  });

  it("hashes the front as the composer will write it, not as generated", () => {
    // A multi-line front is collapsed into one heading line on save, so the id
    // has to be taken over the collapsed form or nothing would ever match.
    expect(generatedCardId(card("What is\nthe median?"))).toBe(
      generateFlashcardId("What is the median?"),
    );
    expect(generatedCardId(card("  Median?  "))).toBe(
      generateFlashcardId("Median?"),
    );
  });
});

describe("partitionAgainstDeck", () => {
  it("keeps cards the destination does not have", () => {
    const cards = [card("A"), card("B")];
    const { fresh, duplicates } = partitionAgainstDeck(cards, new Set());
    expect(fresh).toEqual(cards);
    expect(duplicates).toEqual([]);
  });

  it("separates out cards the destination already holds", () => {
    const existing = new Set([generateFlashcardId("A")]);
    const { fresh, duplicates } = partitionAgainstDeck(
      [card("A"), card("B")],
      existing,
    );
    expect(fresh.map((c) => c.front)).toEqual(["B"]);
    expect(duplicates.map((c) => c.front)).toEqual(["A"]);
  });

  it("collapses cards that duplicate each other within the batch", () => {
    // In-session dedup only compares against what a run has already surfaced, so
    // two rounds can still produce the same front.
    const { fresh, duplicates } = partitionAgainstDeck(
      [card("A", "first"), card("A", "second"), card("B")],
      new Set(),
    );
    expect(fresh.map((c) => c.back)).toEqual(["first", "a"]);
    expect(duplicates).toHaveLength(1);
  });

  it("preserves the proposed order on both sides", () => {
    const existing = new Set([generateFlashcardId("B")]);
    const { fresh, duplicates } = partitionAgainstDeck(
      [card("A"), card("B"), card("C")],
      existing,
    );
    expect(fresh.map((c) => c.front)).toEqual(["A", "C"]);
    expect(duplicates.map((c) => c.front)).toEqual(["B"]);
  });
});

describe("heldByOtherDecks", () => {
  const decks = new Map([
    [generateFlashcardId("A"), "deck_here"],
    [generateFlashcardId("B"), "deck_other"],
  ]);
  const db = {
    getFlashcardById: async (id: string): Promise<Flashcard | null> =>
      decks.has(id) ? ({ id, deckId: decks.get(id) } as Flashcard) : null,
  };

  it("names the proposals another deck holds, not this one's or new ones", async () => {
    const [a, b, c] = [card("A"), card("B"), card("C")];
    expect([...(await heldByOtherDecks(db, [a, b, c], "deck_here"))]).toEqual([b]);
  });

  it("counts every holder as another deck when the note is not a deck yet", async () => {
    const [a, b] = [card("A"), card("B")];
    expect([...(await heldByOtherDecks(db, [a, b], null))]).toEqual([a, b]);
  });
});
