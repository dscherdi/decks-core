import { wouldEmptyDeck } from "../FlashcardSynchronizer";

describe("wouldEmptyDeck", () => {
  // The case that cost a real vault its cards: the note read fine, the parse
  // found nothing because the profile's header level no longer matched, and
  // every card in every deck was deleted by one refresh.
  it("refuses a parse that would empty a deck with cards", () => {
    expect(wouldEmptyDeck(0, 42)).toBe(true);
  });

  it("still refuses when the file was read as empty", () => {
    expect(wouldEmptyDeck(0, 42, false)).toBe(true);
  });

  it("allows a deck that was already empty to stay empty", () => {
    expect(wouldEmptyDeck(0, 0)).toBe(false);
  });

  it("allows a parse that found cards", () => {
    expect(wouldEmptyDeck(7, 42)).toBe(false);
  });

  // A canvas whose last edge was removed genuinely has no cards left, and the
  // caller is the only thing that knows that.
  it("lets a caller opt out where emptiness is a real state", () => {
    expect(wouldEmptyDeck(0, 42, true)).toBe(false);
  });

  it("does not refuse a first sync of a new deck", () => {
    expect(wouldEmptyDeck(0, 0, false)).toBe(false);
  });
});
