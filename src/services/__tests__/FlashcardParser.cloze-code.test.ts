import { FlashcardParser } from "../FlashcardParser";

/**
 * A note that explains the cloze syntax writes it in code — `==like this==` —
 * and the renderer leaves code spans alone. A cloze taken from one could
 * therefore never be masked: the card would show its own answer and could not
 * be answered. The getting-started deck is exactly such a note, so this is the
 * first card a new user sees.
 */
describe("FlashcardParser cloze deletions and inline code", () => {
  const parse = (body: string) =>
    FlashcardParser.parseFlashcardsFromContent(
      ["## Cloze deletions", body].join("\n"),
      2,
      undefined,
      true
    );

  it("does not make a cloze out of markers inside inline code", () => {
    const cards = parse(
      "Use `==highlight==` syntax to create fill-in-the-blank cards."
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("header-paragraph");
    expect(cards[0].clozeOrder).toBeUndefined();
  });

  it("still makes a cloze out of markers in ordinary prose", () => {
    const cards = parse("The capital of France is ==Paris==.");

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("cloze");
  });

  it("numbers the real deletions in order when code sits between them", () => {
    const cards = parse(
      "==Alpha== is written `==like this==` and ==Beta== follows."
    );

    // Two cards, not three: the one in code is skipped, and skipping it must
    // not leave a hole in the numbering.
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.clozeOrder)).toEqual([0, 1]);
  });

  it("handles a double-backtick fence around a single backtick", () => {
    const cards = parse("Escape it as ``==a==`` when writing about it.");

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("header-paragraph");
  });
});
