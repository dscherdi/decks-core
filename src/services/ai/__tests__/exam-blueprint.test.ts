import {
  autoWeightByPages,
  blueprintTotal,
  clampSectionQuestions,
  mixFromPool,
  mixTotal,
  sectionHasNothingToLearn,
  type BlueprintSection,
} from "../exam-blueprint";

const section = (
  id: string,
  pages: number,
  over: Partial<BlueprintSection> = {},
): BlueprintSection => ({
  id,
  title: id,
  startPage: 1,
  endPage: pages,
  pages,
  cards: 0,
  questions: 0,
  ...over,
});

describe("autoWeightByPages", () => {
  it("splits in proportion to pages", () => {
    const out = autoWeightByPages([section("a", 10), section("b", 30)], 40);
    expect(out.map((s) => s.questions)).toEqual([10, 30]);
  });

  it("sums to exactly the total when the split does not divide evenly", () => {
    const sections = [section("a", 13), section("b", 8), section("c", 3)];
    const out = autoWeightByPages(sections, 40);
    // A per-section round would land on 39 or 41; largest remainder cannot.
    expect(blueprintTotal(out)).toBe(40);
  });

  it("gives the remainder to the largest fractional share", () => {
    const out = autoWeightByPages([section("a", 1), section("b", 1), section("c", 1)], 4);
    expect(blueprintTotal(out)).toBe(4);
    expect(out.filter((s) => s.questions === 2)).toHaveLength(1);
  });

  it("skips an excluded section entirely", () => {
    const out = autoWeightByPages(
      [section("a", 10), section("sol", 10, { excluded: true })],
      20,
    );
    expect(out.map((s) => s.questions)).toEqual([20, 0]);
  });

  it("skips a section with no selected pages", () => {
    const out = autoWeightByPages([section("a", 10), section("b", 0)], 10);
    expect(out.map((s) => s.questions)).toEqual([10, 0]);
  });

  it("assigns nothing when there is nothing to assign", () => {
    expect(autoWeightByPages([section("a", 10)], 0)[0].questions).toBe(0);
    expect(autoWeightByPages([section("a", 0)], 10)[0].questions).toBe(0);
    expect(autoWeightByPages([], 10)).toEqual([]);
  });
});

describe("unselected sections", () => {
  it("are listed but never weighted or counted", () => {
    const out = autoWeightByPages(
      [section("a", 10), section("other", 30, { unselected: true, questions: 5 })],
      8,
    );
    expect(out.map((s) => s.questions)).toEqual([8, 0]);
    expect(blueprintTotal([section("a", 1, { questions: 3 }), section("b", 1, { questions: 9, unselected: true })])).toBe(3);
  });
});

describe("blueprintTotal", () => {
  it("leaves an excluded section out of the total", () => {
    expect(
      blueprintTotal([
        section("a", 1, { questions: 5 }),
        section("b", 1, { questions: 7, excluded: true }),
      ]),
    ).toBe(5);
  });
});

describe("clampSectionQuestions", () => {
  it("keeps the count a whole number in range", () => {
    expect(clampSectionQuestions(-3)).toBe(0);
    expect(clampSectionQuestions(4.6)).toBe(5);
    expect(clampSectionQuestions(1000)).toBe(99);
    expect(clampSectionQuestions(Number.NaN)).toBe(0);
  });
});

describe("sectionHasNothingToLearn", () => {
  const extracted = new Set([80, 81, 82]);

  it("excludes a section whose read pages yielded no concepts", () => {
    expect(sectionHasNothingToLearn([80, 81], extracted, {})).toBe(true);
  });

  it("keeps a section with a concept on any page", () => {
    expect(sectionHasNothingToLearn([80, 81], extracted, { 81: 2 })).toBe(false);
  });

  it("keeps a section nobody has read — that is a gap, not a solutions page", () => {
    expect(sectionHasNothingToLearn([90], extracted, {})).toBe(false);
  });

  it("claims nothing about an empty section", () => {
    expect(sectionHasNothingToLearn([], extracted, {})).toBe(false);
  });
});

describe("mixTotal", () => {
  it("counts what this run writes alongside what the deck already holds", () => {
    expect(mixTotal({ generated: 20, mcq: 4, typeIn: 12, cloze: 8 })).toBe(44);
  });
});

describe("mixFromPool", () => {
  it("counts a cloze card apart from a plain type-in", () => {
    expect(
      mixFromPool([
        { kind: "multiple-choice", isCloze: false },
        { kind: "type-in", isCloze: true },
        { kind: "type-in", isCloze: false },
        { kind: "type-in", isCloze: true },
      ]),
    ).toEqual({ generated: 0, mcq: 1, typeIn: 1, cloze: 2 });
  });

  it("is empty for an empty pool", () => {
    expect(mixFromPool([])).toEqual({ generated: 0, mcq: 0, typeIn: 0, cloze: 0 });
  });
});
