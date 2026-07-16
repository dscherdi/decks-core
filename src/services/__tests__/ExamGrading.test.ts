import {
  checkTypeInGradability,
  getTypeInAnswerLine,
  indexSetsEqual,
  isTypedAnswerCorrect,
  normalizeExamAnswer,
  stripInlineMarkdown,
} from "../ExamGrading";

describe("normalizeExamAnswer", () => {
  it("trims, collapses whitespace and casefolds", () => {
    expect(normalizeExamAnswer("  The   Mitochondrion  ")).toBe("the mitochondrion");
  });

  it("strips diacritics", () => {
    expect(normalizeExamAnswer("Curaçao")).toBe("curacao");
    expect(normalizeExamAnswer("Ångström")).toBe("angstrom");
  });
});

describe("stripInlineMarkdown", () => {
  it("removes emphasis, highlight, code and link syntax", () => {
    expect(stripInlineMarkdown("**bold** ==mark== `code`")).toBe("bold mark code");
    expect(stripInlineMarkdown("[[Page|alias]] and [text](https://x)")).toBe(
      "alias and text"
    );
    expect(stripInlineMarkdown("![[image.png]] rest")).toBe(" rest");
  });
});

describe("isTypedAnswerCorrect", () => {
  it("exact mode requires normalized equality", () => {
    expect(isTypedAnswerCorrect(" argon ", "Argon", "exact")).toBe(true);
    expect(isTypedAnswerCorrect("argom", "Argon", "exact")).toBe(false);
  });

  it("tolerant mode floors short answers to exact", () => {
    expect(isTypedAnswerCorrect("H2O", "H2O", "tolerant")).toBe(true);
    expect(isTypedAnswerCorrect("H2P", "H2O", "tolerant")).toBe(false);
  });

  it("tolerant mode accepts one edit from 4 chars up", () => {
    expect(isTypedAnswerCorrect("argom", "Argon", "tolerant")).toBe(true);
    expect(isTypedAnswerCorrect("argoms", "Argon", "tolerant")).toBe(false);
  });

  it("tolerant mode accepts >85% similarity on long answers", () => {
    expect(
      isTypedAnswerCorrect("oxidative phosphorilation", "oxidative phosphorylation", "tolerant")
    ).toBe(true);
    expect(isTypedAnswerCorrect("golgi apparatus", "oxidative phosphorylation", "tolerant")).toBe(
      false
    );
  });
});

describe("indexSetsEqual", () => {
  it("compares as sets", () => {
    expect(indexSetsEqual([0, 2], [2, 0])).toBe(true);
    expect(indexSetsEqual([0, 2, 2], [2, 0])).toBe(true);
    expect(indexSetsEqual([0], [0, 1])).toBe(false);
    expect(indexSetsEqual([], [])).toBe(true);
  });
});

describe("getTypeInAnswerLine", () => {
  it("prefers the cloze target segment", () => {
    expect(getTypeInAnswerLine("irrelevant body", "==unused== mitochondrion")).toBe(
      "unused mitochondrion"
    );
  });

  it("falls back to the first non-empty back line, markdown-stripped", () => {
    expect(getTypeInAnswerLine("\n\n**The mitochondrion.**\nMore detail.", null)).toBe(
      "The mitochondrion."
    );
  });
});

describe("checkTypeInGradability", () => {
  it("rejects embed-only answers", () => {
    expect(checkTypeInGradability("").gradable).toBe(false);
  });

  it("rejects over-long answers", () => {
    expect(checkTypeInGradability("x".repeat(121)).gradable).toBe(false);
    expect(checkTypeInGradability("x".repeat(120)).gradable).toBe(true);
  });
});
