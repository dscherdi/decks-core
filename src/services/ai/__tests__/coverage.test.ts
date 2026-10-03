import {
  formatPageList,
  gapPages,
  heatTone,
  pageHeat,
  summarizeHeat,
} from "../coverage";

const sourced = (...pages: number[]) => new Set(pages);

describe("pageHeat", () => {
  it("emits one cell per sent page, with its card count", () => {
    expect(pageHeat(68, 71, sourced(68, 69, 70, 71), { 68: 3, 70: 1 })).toEqual([
      { page: 68, count: 3 },
      { page: 69, count: 0 },
      { page: 70, count: 1 },
      { page: 71, count: 0 },
    ]);
  });

  it("omits pages that were never sent", () => {
    // A page outside the selection is not a gap — nobody was asked about it, so
    // showing it empty would invite generating for material never offered.
    expect(pageHeat(68, 72, sourced(68, 72), {})).toEqual([
      { page: 68, count: 0 },
      { page: 72, count: 0 },
    ]);
  });

  it("is empty for a chapter with nothing sent", () => {
    expect(pageHeat(93, 108, sourced(), {})).toEqual([]);
  });
});

describe("summarizeHeat", () => {
  it("counts covered, thin and untouched over the cells drawn", () => {
    const cells = pageHeat(68, 75, sourced(68, 69, 70, 71, 72, 73, 74, 75), {
      68: 4,
      69: 3,
      70: 1,
      71: 2,
      72: 5,
    });
    expect(summarizeHeat(cells)).toEqual({
      total: 8,
      covered: 5,
      thin: 2,
      untouched: 3,
    });
  });

  it("covered and untouched always account for every cell", () => {
    const cells = pageHeat(1, 6, sourced(1, 2, 3, 4, 5, 6), { 2: 9, 5: 1 });
    const s = summarizeHeat(cells);
    expect(s.covered + s.untouched).toBe(s.total);
    expect(s.total).toBe(cells.length);
  });

  it("reports nothing covered for a section with no cards", () => {
    const cells = pageHeat(76, 78, sourced(76, 77, 78), {});
    expect(summarizeHeat(cells)).toEqual({
      total: 3,
      covered: 0,
      thin: 0,
      untouched: 3,
    });
  });
});

describe("heatTone", () => {
  it("bands at three cards", () => {
    expect(heatTone(0)).toBe("none");
    expect(heatTone(1)).toBe("thin");
    expect(heatTone(2)).toBe("thin");
    expect(heatTone(3)).toBe("strong");
    expect(heatTone(40)).toBe("strong");
  });
});

describe("gapPages", () => {
  it("returns the sent pages nothing cites, ascending", () => {
    expect(gapPages(sourced(70, 68, 71, 69), { 69: 2, 71: 1 })).toEqual([68, 70]);
  });

  it("is empty when everything is covered", () => {
    expect(gapPages(sourced(1, 2), { 1: 1, 2: 1 })).toEqual([]);
  });
});

describe("formatPageList", () => {
  it("condenses runs into ranges", () => {
    expect(formatPageList([76, 77, 78, 91, 104, 105, 106])).toBe(
      "76–78, 91, 104–106",
    );
  });

  it("sorts and tolerates duplicates", () => {
    expect(formatPageList([5, 3, 4, 4])).toBe("3–5");
  });

  it("handles a single page and an empty list", () => {
    expect(formatPageList([7])).toBe("7");
    expect(formatPageList([])).toBe("");
  });
});
