import {
  clusterPages,
  missedPages,
  missesSectionCards,
  missesSessionPrompt,
  missesSummary,
  weakSections,
  type AttemptMiss,
} from "../exam-misses";

const miss = (index: number, page: number | null, unanswered = false): AttemptMiss => ({
  index,
  cardId: `card_${index}`,
  page,
  unanswered,
});

describe("missedPages", () => {
  it("collects each cited page once, ascending", () => {
    expect(missedPages([miss(1, 77), miss(2, 73), miss(3, 77)])).toEqual([73, 77]);
  });

  it("leaves out a miss whose card cites no page", () => {
    expect(missedPages([miss(1, null), miss(2, 73)])).toEqual([73]);
  });
});

describe("clusterPages", () => {
  it("keeps a run together across a small gap", () => {
    expect(clusterPages([68, 70, 71], 2)).toEqual([[68, 70, 71]]);
  });

  it("breaks a run when the gap is too wide", () => {
    expect(clusterPages([68, 69, 90], 2)).toEqual([[68, 69], [90]]);
  });

  it("sorts and deduplicates first", () => {
    expect(clusterPages([9, 5, 5, 6], 1)).toEqual([[5, 6], [9]]);
  });

  it("handles an empty list", () => {
    expect(clusterPages([])).toEqual([]);
  });
});

describe("weakSections", () => {
  it("asks for cards where there are none", () => {
    const [section] = weakSections([miss(1, 76), miss(2, 77)], {});
    expect(section).toMatchObject({
      startPage: 76,
      endPage: 77,
      misses: 2,
      cards: 0,
      action: "generate",
    });
  });

  it("asks for repair where cards exist and are still missed", () => {
    // The distinction the whole feature turns on: more cards would not help.
    const [section] = weakSections([miss(1, 70), miss(2, 71)], { 70: 8, 71: 6 });
    expect(section).toMatchObject({ cards: 14, action: "repair" });
  });

  it("puts the worst cluster first", () => {
    const sections = weakSections(
      [miss(1, 60), miss(2, 76), miss(3, 77), miss(4, 77)],
      {},
    );
    expect(sections.map((s) => s.misses)).toEqual([3, 1]);
    expect(sections[0].startPage).toBe(76);
  });

  it("breaks ties by page, so the order does not wobble", () => {
    const sections = weakSections([miss(1, 90), miss(2, 55)], {});
    expect(sections.map((s) => s.startPage)).toEqual([55, 90]);
  });

  it("ignores misses with no page rather than inventing one", () => {
    expect(weakSections([miss(1, null)], {})).toEqual([]);
  });
});

describe("miss wording", () => {
  it("says a single miss, or a single section, in the singular", () => {
    expect(missesSummary(1, 1)).toBe("1 miss in 1 section");
    expect(missesSummary(3, 1)).toBe("3 misses in 1 section");
    expect(missesSummary(3, 2)).toBe("3 misses across 2 sections");
  });

  it("counts a section's cards in the singular at one", () => {
    expect(missesSectionCards(1)).toBe("1 card");
    expect(missesSectionCards(4)).toBe("4 cards");
  });

  it("names one page as a page and several as pages", () => {
    expect(missesSessionPrompt([7])).toBe("Write flashcards for what I got wrong: page 7.");
    expect(missesSessionPrompt([7, 7])).toBe("Write flashcards for what I got wrong: page 7.");
    expect(missesSessionPrompt([3, 4, 9])).toBe("Write flashcards for what I got wrong: pages 3–4, 9.");
  });

  it("names the missed concepts when the ledger knows them", () => {
    expect(
      missesSessionPrompt([3, 9], [
        { term: "Median", page: 3 },
        { term: "Boxplot", page: 9 },
      ]),
    ).toBe("Write flashcards for what I got wrong: Median (p. 3), Boxplot (p. 9).");
  });
});
