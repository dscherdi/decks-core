import { flagTally, hubTotals, keepRate, relativeAge } from "../hub";

describe("keepRate", () => {
  it("counts only decided cards", () => {
    expect(keepRate(84, 31)).toBe(73);
    expect(keepRate(3, 1)).toBe(75);
  });

  it("is null when nothing has been decided", () => {
    // A freshly generated batch has no verdict from the user yet. Showing 0%
    // would read as failure, and the figure would climb on its own as they
    // merely triaged.
    expect(keepRate(0, 0)).toBeNull();
  });

  it("reaches both extremes", () => {
    expect(keepRate(5, 0)).toBe(100);
    expect(keepRate(0, 5)).toBe(0);
  });
});

describe("flagTally", () => {
  it("counts a card under every rule it broke", () => {
    const tally = flagTally([
      { rubricCodes: ["enumeration", "two_facts"] },
      { rubricCodes: ["enumeration"] },
      { rubricCodes: ["answer_leak"] },
    ]);
    expect(tally).toEqual([
      { code: "enumeration", count: 2 },
      { code: "answer_leak", count: 1 },
      { code: "two_facts", count: 1 },
    ]);
  });

  it("does not double-count a rule repeated on one card", () => {
    expect(flagTally([{ rubricCodes: ["trivial", "trivial"] }])).toEqual([
      { code: "trivial", count: 1 },
    ]);
  });

  it("is empty when nothing is flagged", () => {
    expect(flagTally([])).toEqual([]);
    expect(flagTally([{ rubricCodes: [] }])).toEqual([]);
  });
});

describe("hubTotals", () => {
  it("sums the pile across sessions", () => {
    expect(
      hubTotals([
        { staged: 12, flagged: 3, saved: 40 },
        { staged: 31, flagged: 8, saved: 0 },
      ]),
    ).toEqual({ staged: 43, flagged: 11, sessions: 2 });
  });

  it("counts a session with nothing staged", () => {
    // An empty session is one you started and have not generated into, not one
    // that does not exist.
    expect(hubTotals([{ staged: 0, flagged: 0, saved: 96 }]).sessions).toBe(1);
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-09-16T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("reads in the coarsest unit that still says something", () => {
    expect(relativeAge(ago(30 * 1000), now)).toEqual({ unit: "now", count: 0 });
    expect(relativeAge(ago(5 * 60000), now)).toEqual({
      unit: "minute",
      count: 5,
    });
    expect(relativeAge(ago(2 * 3600_000), now)).toEqual({
      unit: "hour",
      count: 2,
    });
    expect(relativeAge(ago(3 * 86400_000), now)).toEqual({
      unit: "day",
      count: 3,
    });
    expect(relativeAge(ago(9 * 86400_000), now)).toEqual({
      unit: "week",
      count: 1,
    });
  });

  it("does not throw on a timestamp it cannot read", () => {
    expect(relativeAge("not a date", now)).toEqual({ unit: "now", count: 0 });
  });
});
