import { wouldEmptyDeck } from "../FlashcardSynchronizer";

const edited = { contentEmpty: false };
const unreadable = { contentEmpty: true };

describe("wouldEmptyDeck", () => {
  // An empty read is a race, not an edit — a live deck file has at least its
  // frontmatter tag — so this protection is unconditional.
  it("always refuses when the file read back empty", () => {
    expect(wouldEmptyDeck(0, 42, unreadable)).toBe(true);
  });

  // The default has to stay "empty it": a note whose cards were cut out and
  // pasted elsewhere parses to nothing, and the old deck must clear so the
  // history can follow the cards to their new home.
  it("empties a deck on an edit, which is how a deck moves", () => {
    expect(wouldEmptyDeck(0, 42, edited)).toBe(false);
  });

  // Only a caller that knows the note has not changed can tell that an empty
  // parse is a configuration fault rather than an edit.
  it("refuses when the caller says the note did not change", () => {
    expect(wouldEmptyDeck(0, 42, { contentEmpty: false, refuseEmptyResult: true })).toBe(true);
  });

  it("never refuses a deck that was already empty", () => {
    expect(wouldEmptyDeck(0, 0, unreadable)).toBe(false);
  });

  it("never refuses a parse that found cards", () => {
    expect(wouldEmptyDeck(7, 42, unreadable)).toBe(false);
  });
});
