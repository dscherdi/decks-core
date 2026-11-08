import type { Flashcard } from "../../database/types";
import { clozeActiveOrders, clozeLineOrders, clozeOrderRange, clozeSource, groupClozeRunByLine } from "../cloze-lines";
import { prepareClozeMath } from "../clozeMath";

const BODY = "The ==heart== pumps ==blood==.\nThe ==lungs== take in ==air== and `==code==`.\nNo clozes here.\n- ==last==";

function card(order: number, overrides: Partial<Flashcard> = {}): Flashcard {
  return {
    id: `card_${order}`,
    deckId: "deck_a",
    front: "Body",
    back: BODY,
    type: "cloze",
    sourceFile: "Body.md",
    contentHash: "h",
    breadcrumb: "",
    notes: "",
    clozeText: null,
    clozeOrder: order,
    sourceNodeId: null,
    edgeId: null,
    hint: "",
    state: "new",
    dueDate: "2026-11-07T00:00:00.000Z",
    interval: 0,
    repetitions: 0,
    difficulty: 5,
    stability: 0,
    lapses: 0,
    lastReviewed: null,
    created: "2026-11-07T00:00:00.000Z",
    modified: "2026-11-07T00:00:00.000Z",
    tags: [],
    suspendedAt: null,
    buriedUntil: null,
    templateRow: null,
    anchor: null,
    ...overrides,
  };
}

describe("clozeLineOrders", () => {
  it("returns every deletion on the line, skipping code spans the parser skips", () => {
    expect(clozeLineOrders(BODY, 0)).toEqual([0, 1]);
    expect(clozeLineOrders(BODY, 1)).toEqual([0, 1]);
    expect(clozeLineOrders(BODY, 3)).toEqual([2, 3]);
    expect(clozeLineOrders(BODY, 4)).toEqual([4]);
  });

  it("falls back to the order alone when the source has no such deletion", () => {
    expect(clozeLineOrders(BODY, 9)).toEqual([9]);
    expect(clozeLineOrders("", 0)).toEqual([0]);
  });
});

describe("clozeActiveOrders", () => {
  it("is the card's own order when not grouped", () => {
    expect(clozeActiveOrders(card(1), false)).toEqual([1]);
  });

  it("is the whole line when grouped", () => {
    expect(clozeActiveOrders(card(1), true)).toEqual([0, 1]);
    expect(clozeActiveOrders(card(4), true)).toEqual([4]);
  });

  it("leaves other card types alone", () => {
    expect(clozeActiveOrders(card(0, { type: "image-occlusion" }), true)).toEqual([0]);
  });

  it("reads a front-only cloze from its front", () => {
    const frontOnly = card(1, { front: "==Paris== is in ==France==", back: "" });
    expect(clozeSource(frontOnly)).toBe("==Paris== is in ==France==");
    expect(clozeActiveOrders(frontOnly, true)).toEqual([0, 1]);
  });
});

describe("groupClozeRunByLine", () => {
  it("keeps one card per step when not grouped", () => {
    const run = [card(2), card(0), card(1)];
    expect(groupClozeRunByLine(run, false).map((step) => step.map((c) => c.id))).toEqual([
      ["card_2"],
      ["card_0"],
      ["card_1"],
    ]);
  });

  it("puts line-mates in one step, in order of first appearance", () => {
    const run = [card(3), card(0), card(4), card(2), card(1)];
    expect(groupClozeRunByLine(run, true).map((step) => step.map((c) => c.id))).toEqual([
      ["card_3", "card_2"],
      ["card_0", "card_1"],
      ["card_4"],
    ]);
  });

  it("never merges two notes that share a line index", () => {
    const other = card(0, { id: "other_0", back: "A ==x== and ==y==" });
    expect(groupClozeRunByLine([card(0), other], true)).toHaveLength(2);
  });
});

describe("prepareClozeMath with several active clozes", () => {
  it("reports each active cloze among the marks", () => {
    const prepared = prepareClozeMath("==a== ==b== ==c==", [0, 1], "hidden", false);
    expect(prepared.markActiveIndices).toEqual([0, 1]);
    expect(prepared.markActiveIndex).toBe(0);
  });

  it("blanks every active cloze inside math and maps the rest", () => {
    const prepared = prepareClozeMath("==a== $x = ==y==$ ==b==", [0, 1, 2], "open", false);
    expect(prepared.markdown).toBe("==a== $x = \\boxed{?}$ ==b==");
    expect(prepared.markActiveIndices).toEqual([0, 1]);
  });

  it("keeps the single-order form unchanged", () => {
    expect(prepareClozeMath("==a== ==b==", 1, "open", false).markActiveIndices).toEqual([1]);
  });
});

describe("clozeOrderRange", () => {
  it("labels one cloze or a line of them, one-based", () => {
    expect(clozeOrderRange([1])).toBe("2");
    expect(clozeOrderRange([2, 3, 4])).toBe("3–5");
    expect(clozeOrderRange([])).toBe("");
  });
});
