import { FlashcardParser } from "../FlashcardParser";

describe("FlashcardParser multi-level header parsing", () => {
  it("parses both H2 and H3 as sibling cards", () => {
    const content = [
      "## Photosynthesis",
      "Intro about photosynthesis.",
      "",
      "### Light reactions",
      "Details about light reactions.",
      "",
      "### Calvin cycle",
      "Details about the Calvin cycle.",
    ].join("\n");

    const cards = FlashcardParser.parseFlashcardsFromContent(content, [2, 3]);

    expect(cards.map((c) => c.front)).toEqual([
      "Photosynthesis",
      "Light reactions",
      "Calvin cycle",
    ]);
    // The parent's back is only the text before its first sub-header.
    expect(cards[0].back).toBe("Intro about photosynthesis.");
    expect(cards[1].back).toBe("Details about light reactions.");
    expect(cards[2].back).toBe("Details about the Calvin cycle.");
  });

  it("does not create a card for an intro-less parent header", () => {
    const content = [
      "## Container",
      "### Sub A",
      "Body A.",
      "",
      "### Sub B",
      "Body B.",
    ].join("\n");

    const cards = FlashcardParser.parseFlashcardsFromContent(content, [2, 3]);

    // "Container" has no body text before its first sub-header → no card.
    expect(cards.map((c) => c.front)).toEqual(["Sub A", "Sub B"]);
  });

  it("supports non-adjacent levels (H1 + H3), ignoring the level between", () => {
    const content = [
      "# Chapter",
      "Chapter intro.",
      "",
      "## Section",
      "### Point",
      "Point body.",
    ].join("\n");

    const cards = FlashcardParser.parseFlashcardsFromContent(content, [1, 3]);

    expect(cards.map((c) => c.front)).toEqual(["Chapter", "Point"]);
    expect(cards[0].back).toBe("Chapter intro.");
    expect(cards[1].back).toBe("Point body.");
  });

  it("treats a single-element array the same as a single number (regression)", () => {
    const content = ["## A", "Body A.", "## B", "Body B."].join("\n");

    const asNumber = FlashcardParser.parseFlashcardsFromContent(content, 2);
    const asArray = FlashcardParser.parseFlashcardsFromContent(content, [2]);

    expect(asArray).toEqual(asNumber);
    expect(asNumber.map((c) => c.front)).toEqual(["A", "B"]);
  });

  it("does not turn a deeper header into a card when only the primary is selected", () => {
    const content = [
      "## Topic",
      "Topic body.",
      "",
      "### Detail",
      "Detail body.",
    ].join("\n");

    const cards = FlashcardParser.parseFlashcardsFromContent(content, [2]);

    expect(cards.map((c) => c.front)).toEqual(["Topic"]);
    expect(cards[0].back).toBe("Topic body.");
  });

  it("still supports title mode via a [0] set", () => {
    const content = "Some note body.\nSecond line.";
    const cards = FlashcardParser.parseFlashcardsFromContent(content, [0], "My Title");

    expect(cards).toHaveLength(1);
    expect(cards[0].front).toBe("My Title");
    expect(cards[0].back).toBe("Some note body.\nSecond line.");
  });

  it("generates cloze cards from a non-primary selected level", () => {
    const content = [
      "## Primary",
      "Primary body.",
      "",
      "### Extra",
      "The capital is ==Paris==.",
    ].join("\n");

    const cards = FlashcardParser.parseFlashcardsFromContent(content, [2, 3], undefined, true);

    const cloze = cards.find((c) => c.type === "cloze");
    expect(cloze).toBeDefined();
    expect(cloze?.clozeText).toBe("Paris");
  });
});
