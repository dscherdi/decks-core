import {
  buildConceptMessages,
  buildConceptRows,
  cardsForConcepts,
  cleanConcepts,
  conceptNeedle,
  conceptsByPage,
  conceptState,
  filterConceptRows,
  pageConceptTone,
  parseConcepts,
  tallyConcepts,
} from "../concepts";
import { CARD_DELIMITER } from "../prompts";

const block = (term: string, page: string, blurb = "b"): string =>
  `TERM: ${term}\nPAGE: ${page}\nBLURB: ${blurb}\n${CARD_DELIMITER}\n`;

describe("parseConcepts", () => {
  it("reads term, page and blurb", () => {
    expect(parseConcepts(block("Median", "61", "Middle of the ordered series"))).toEqual([
      { term: "Median", page: 61, blurb: "Middle of the ordered series" },
    ]);
  });

  it("skips a block with no term or no usable page", () => {
    // A half-parsed extraction should lose a concept, never throw.
    const text =
      block("Median", "61") + `TERM:\nPAGE: 62\n${CARD_DELIMITER}\n` + block("Varianz", "n/a");
    expect(parseConcepts(text).map((c) => c.term)).toEqual(["Median"]);
  });

  it("reads a page the model wrote as the source's own label", () => {
    const text = block("Median", "[p. 61]") + block("Mode", "p. 62");
    expect(parseConcepts(text).map((c) => c.page)).toEqual([61, 62]);
  });

  it("returns nothing for a page the model reported as bare", () => {
    expect(parseConcepts("")).toEqual([]);
  });
});

describe("cleanConcepts", () => {
  const sourced = new Set([61, 62]);

  it("drops a concept on a page the source never offered", () => {
    const got = cleanConcepts(
      [
        { term: "Median", page: 61, blurb: "" },
        { term: "Invented", page: 99, blurb: "" },
      ],
      sourced,
    );
    expect(got.map((c) => c.term)).toEqual(["Median"]);
  });

  it("collapses the same term repeated on one page", () => {
    const got = cleanConcepts(
      [
        { term: "Median", page: 61, blurb: "first" },
        { term: "median", page: 61, blurb: "second" },
      ],
      sourced,
    );
    expect(got).toHaveLength(1);
    expect(got[0].blurb).toBe("first");
  });

  it("keeps the same term on two different pages", () => {
    // The same idea introduced twice is two places to revise from.
    const got = cleanConcepts(
      [
        { term: "Median", page: 61, blurb: "" },
        { term: "Median", page: 62, blurb: "" },
      ],
      sourced,
    );
    expect(got).toHaveLength(2);
  });
});

describe("conceptState", () => {
  it("names the four states", () => {
    expect(conceptState({ cards: 0, failing: 0 })).toBe("no_card");
    expect(conceptState({ cards: 1, failing: 0, crammed: 1 })).toBe("thin");
    expect(conceptState({ cards: 4, failing: 0 })).toBe("holding");
    expect(conceptState({ cards: 4, failing: 2 })).toBe("failing");
  });

  it("puts failing above thin", () => {
    // One card that keeps being got wrong wants repair, not a second card.
    expect(conceptState({ cards: 1, failing: 1, crammed: 1 })).toBe("failing");
  });

  it("holds a single card that carries one fact", () => {
    expect(conceptState({ cards: 1, failing: 0 })).toBe("holding");
  });
});

describe("tallyConcepts", () => {
  it("counts every concept exactly once", () => {
    const t = tallyConcepts([
      { cards: 0, failing: 0 },
      { cards: 0, failing: 0 },
      { cards: 1, failing: 0, crammed: 1 },
      { cards: 3, failing: 1 },
      { cards: 5, failing: 0 },
    ]);
    expect(t).toEqual({ no_card: 2, thin: 1, failing: 1, holding: 1, total: 5 });
    expect(t.no_card + t.thin + t.failing + t.holding).toBe(t.total);
  });
});

describe("pageConceptTone", () => {
  it("separates a solutions page from a gap", () => {
    // This is the whole reason the ledger exists: page counts alone cannot tell
    // "nothing to learn here" from "something here and no card".
    expect(pageConceptTone(true, 0, 0)).toBe("empty");
    expect(pageConceptTone(true, 3, 0)).toBe("uncovered");
  });

  it("says nothing about a page that was never read", () => {
    expect(pageConceptTone(false, 0, 0)).toBe("empty");
  });

  it("bands covered pages at three cards", () => {
    expect(pageConceptTone(true, 2, 1)).toBe("thin");
    expect(pageConceptTone(true, 2, 3)).toBe("strong");
  });
});

describe("buildConceptMessages", () => {
  it("tells the model to skip solutions and exercises", () => {
    const { system } = buildConceptMessages({ source: "x" });
    expect(system).toContain("solutions");
    expect(system).toContain("exercises");
  });

  it("asks for the page from the source's own labels", () => {
    const { system } = buildConceptMessages({ source: "x" });
    expect(system).toContain("[p. N]");
  });

  it("keeps the source in the user message", () => {
    const { system, user } = buildConceptMessages({ source: "the source text" });
    expect(user).toContain("the source text");
    expect(system).not.toContain("the source text");
  });
});

describe("conceptNeedle", () => {
  it("matches a qualified term on its head", () => {
    expect(conceptNeedle("Median · robustness to outliers")).toBe("median");
    expect(conceptNeedle("Variance (sample)")).toBe("variance");
  });

  it("collapses case and spacing so a card's wording still matches", () => {
    expect(conceptNeedle("  Standard   Deviation ")).toBe("standard deviation");
  });
});

describe("buildConceptRows", () => {
  const concepts = [
    { id: "c1", term: "Median", page: 61, blurb: "" },
    { id: "c2", term: "Chebyshev's inequality", page: 73, blurb: "" },
  ];

  it("counts a card that names the concept", () => {
    const rows = buildConceptRows(concepts, [
      { text: "What is the median? The middle value." },
    ]);
    expect(rows[0].cards).toBe(1);
    expect(rows[1].cards).toBe(0);
    expect(rows[1].state).toBe("no_card");
  });

  it("counts a card generated for the concept even when the term is absent", () => {
    const rows = buildConceptRows(concepts, [
      { text: "Which value splits the ordered series?", conceptId: "c1" },
    ]);
    expect(rows[0].cards).toBe(1);
  });

  it("reports a lapsing card as failing, not as covered", () => {
    const rows = buildConceptRows(concepts, [
      { text: "median", lapses: 2 },
      { text: "the median again", lapses: 0 },
    ]);
    expect(rows[0].cards).toBe(2);
    expect(rows[0].failing).toBe(1);
    expect(rows[0].state).toBe("failing");
  });

  it("reports a card missed in an exam as failing", () => {
    const rows = buildConceptRows(concepts, [{ text: "median", lapses: 0, examMisses: 1 }]);
    expect(rows[0].state).toBe("failing");
  });

  it("tallies its rows in the state each row shows", () => {
    const rows = buildConceptRows(concepts, [{ text: "median", crammed: true }]);
    expect(tallyConcepts(rows)).toMatchObject({ thin: 1, holding: 0, no_card: 1 });
  });

  it("calls one crammed card thin and one single-fact card holding", () => {
    expect(buildConceptRows(concepts, [{ text: "median", crammed: true }])[0].state).toBe("thin");
    expect(buildConceptRows(concepts, [{ text: "median" }])[0].state).toBe("holding");
  });

  it("does not attribute a card to an unrelated concept", () => {
    const rows = buildConceptRows(concepts, [{ text: "What is the mean?" }]);
    expect(rows.every((r) => r.cards === 0)).toBe(true);
  });

  it("keeps the concept's page and blurb on the row", () => {
    const rows = buildConceptRows(
      [{ id: "c1", term: "Median", page: 61, blurb: "middle value" }],
      [],
    );
    expect(rows[0]).toMatchObject({ page: 61, blurb: "middle value" });
  });
});

describe("filterConceptRows", () => {
  const rows = buildConceptRows(
    [
      { id: "a", term: "Alpha", page: 1, blurb: "" },
      { id: "b", term: "Beta", page: 2, blurb: "" },
    ],
    [{ text: "beta beta", lapses: 0, crammed: true }],
  );

  it("returns everything for `all`", () => {
    expect(filterConceptRows(rows, "all")).toHaveLength(2);
  });

  it("narrows to one state", () => {
    expect(filterConceptRows(rows, "no_card").map((r) => r.term)).toEqual([
      "Alpha",
    ]);
    expect(filterConceptRows(rows, "thin").map((r) => r.term)).toEqual(["Beta"]);
  });
});

describe("conceptsByPage", () => {
  it("counts the concepts found on each page", () => {
    expect(
      conceptsByPage([
        { term: "a", page: 5, blurb: "" },
        { term: "b", page: 5, blurb: "" },
        { term: "c", page: 7, blurb: "" },
      ]),
    ).toEqual({ 5: 2, 7: 1 });
  });
});

describe("cardsForConcepts", () => {
  const concepts = [
    { id: "a", term: "Median", page: 2, blurb: "" },
    { id: "b", term: "Variance", page: 1, blurb: "" },
  ];
  const cards = [
    { id: "1", text: "What is the median?", lapses: 0, flashcardId: "card_1" },
    { id: "2", text: "Define the median", lapses: 3, flashcardId: "card_2" },
    { id: "3", text: "Something else", conceptId: "b", lapses: 1 },
    { id: "4", text: "Unrelated", lapses: 5 },
  ];

  it("returns the cards the ledger attributes to those concepts, once each", () => {
    expect(cardsForConcepts(concepts, cards).map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(cardsForConcepts([concepts[0]], cards).map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("narrows to the ones that lapse", () => {
    expect(cardsForConcepts(concepts, cards, true).map((c) => c.id)).toEqual(["2", "3"]);
  });
});
