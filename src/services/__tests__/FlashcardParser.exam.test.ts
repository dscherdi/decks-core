import { FlashcardParser } from "../FlashcardParser";

const parse = (content: string, examEnabled = true, clozeEnabled = false) =>
  FlashcardParser.parseFlashcardsFromContent(content, 2, undefined, clozeEnabled, examEnabled);

const QUESTION = [
  "## Which element is a noble gas?",
  "",
  "- [ ] Oxygen",
  "- [x] Argon",
  "- [ ] Nitrogen",
].join("\n");

describe("FlashcardParser multiple-choice", () => {
  it("parses a task-list body as one multiple-choice card when examEnabled", () => {
    const cards = parse(QUESTION);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("multiple-choice");
    expect(cards[0].front).toBe("Which element is a noble gas?");
    expect(cards[0].back).toContain("- [x] Argon");
  });

  it("parses the same body as header-paragraph when examEnabled is off", () => {
    const cards = parse(QUESTION, false);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("header-paragraph");
  });

  it("keeps the back byte-identical between question and fallback parses", () => {
    const asQuestion = parse(QUESTION, true)[0];
    const asPlain = parse(QUESTION, false)[0];
    expect(asQuestion.back).toBe(asPlain.back);
    expect(asQuestion.front).toBe(asPlain.front);
  });

  it("wins over cloze when both flags are on and the body is a valid question", () => {
    const content = [
      "## Pick the ==noble== gas",
      "",
      "- [x] ==Argon==",
      "- [ ] Oxygen",
    ].join("\n");
    const cards = parse(content, true, true);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("multiple-choice");
  });

  it("falls back to the existing paths for invalid question bodies", () => {
    const noAnswer = ["## Q", "", "- [ ] A", "- [ ] B"].join("\n");
    expect(parse(noAnswer)[0].type).toBe("header-paragraph");

    const single = ["## Q", "", "- [x] Only"].join("\n");
    expect(parse(single)[0].type).toBe("header-paragraph");

    const withCloze = ["## Q", "", "- [ ] A", "- [ ] ==B=="].join("\n");
    const clozeCards = parse(withCloze, true, true);
    expect(clozeCards.every((c) => c.type === "cloze")).toBe(true);
  });

  it("extracts notes before classifying (divider and comments stay notes)", () => {
    const content = [
      "## Q",
      "",
      "- [x] A",
      "- [ ] B",
      "",
      "%%Group 18: full valence shell.%%",
    ].join("\n");
    const cards = parse(content);
    expect(cards[0].type).toBe("multiple-choice");
    expect(cards[0].notes).toBe("Group 18: full valence shell.");
    expect(cards[0].back).not.toContain("%%");
  });

  it("adopts a q token as its anchor and keeps a dormant h token inert", () => {
    const content = [
      "## Q",
      "",
      "- [x] A",
      "- [ ] B",
      "%%dk:h:old1%%",
      "",
      "%%dk:q:new2%%",
    ].join("\n");
    const cards = parse(content);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("multiple-choice");
    expect(cards[0].anchorKey).toBe("q:new2");
    expect(cards[0].back).not.toContain("%%dk");
  });

  it("keeps a dormant q token inert for the header-paragraph fallback", () => {
    const content = [
      "## Plain again",
      "",
      "Just a paragraph now.",
      "%%dk:h:old1%%",
      "",
      "%%dk:q:new2%%",
    ].join("\n");
    const cards = parse(content);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("header-paragraph");
    expect(cards[0].anchorKey).toBe("h:old1");
  });

  it("never reverses multiple-choice cards", () => {
    // Reverse expansion happens in the synchronizer; the parser contract here
    // is just that the type is multiple-choice so the synchronizer can skip it.
    const cards = parse(QUESTION);
    expect(cards[0].type).toBe("multiple-choice");
    expect(cards[0].isReverse).toBeUndefined();
  });
});
