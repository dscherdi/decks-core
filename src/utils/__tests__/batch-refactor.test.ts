import type { RefactorFieldSet, RefactorResult } from "../../services/ai/types";
import {
  type BatchCardState,
  acceptAllStates,
  applyBatch,
  cardResultPatch,
  discardAllStates,
  effectiveSplit,
  setCardStatus,
} from "../batch-refactor";

interface TestCard {
  id: string;
  type: string;
}

const card = (id: string, type = "header-paragraph"): TestCard => ({ id, type });

function state(
  id: string,
  status: BatchCardState<TestCard>["status"],
  extra: Partial<BatchCardState<TestCard>> = {},
): BatchCardState<TestCard> {
  return { card: card(id), status, mode: "refactor", proposals: [], ...extra };
}

describe("effectiveSplit", () => {
  it("is true only for splittable types when split is on", () => {
    expect(effectiveSplit(true, "header-paragraph")).toBe(true);
    expect(effectiveSplit(true, "table")).toBe(true);
    expect(effectiveSplit(true, "cloze")).toBe(true);
    expect(effectiveSplit(true, "image-occlusion")).toBe(false);
    expect(effectiveSplit(true, "spatial")).toBe(false);
  });

  it("is false for every type when split is off", () => {
    expect(effectiveSplit(false, "header-paragraph")).toBe(false);
    expect(effectiveSplit(false, "table")).toBe(false);
  });
});

describe("cardResultPatch", () => {
  const proposed: RefactorFieldSet = {
    type: "header-paragraph",
    front: "Q",
    back: "A",
  };

  it("maps a refactor result with proposals to a ready refactor card", () => {
    const res: RefactorResult = {
      proposed,
      proposals: [{ key: "back", before: "a", after: "A" }],
    };
    expect(cardResultPatch(res, false)).toEqual({
      mode: "refactor",
      proposed,
      proposals: res.proposals,
      status: "ready",
    });
  });

  it("maps a refactor result with no proposals to empty", () => {
    const res: RefactorResult = { proposed, proposals: [] };
    expect(cardResultPatch(res, false).status).toBe("empty");
  });

  it("maps a split result with cards to a ready split card", () => {
    const splitCards: RefactorFieldSet[] = [
      { type: "header-paragraph", front: "Q1", back: "A1" },
      { type: "header-paragraph", front: "Q2", back: "A2" },
    ];
    const res: RefactorResult = { proposed, proposals: [], splitCards };
    expect(cardResultPatch(res, true)).toEqual({
      mode: "split",
      splitCards,
      proposals: [],
      status: "ready",
    });
  });

  it("maps a split result with no cards to empty", () => {
    const res: RefactorResult = { proposed, proposals: [], splitCards: [] };
    expect(cardResultPatch(res, true).status).toBe("empty");
  });
});

describe("status transitions", () => {
  it("acceptAllStates stages only Ready cards", () => {
    const out = acceptAllStates([
      state("a", "ready"),
      state("b", "accepted"),
      state("c", "empty"),
    ]);
    expect(out.map((s) => s.status)).toEqual(["accepted", "accepted", "empty"]);
  });

  it("discardAllStates un-stages only Accepted cards", () => {
    const out = discardAllStates([
      state("a", "accepted"),
      state("b", "ready"),
      state("c", "error"),
    ]);
    expect(out.map((s) => s.status)).toEqual(["ready", "ready", "error"]);
  });

  it("setCardStatus moves a single card only from the matching status", () => {
    const states = [state("a", "ready"), state("b", "ready")];
    const out = setCardStatus(states, "a", "ready", "accepted");
    expect(out.find((s) => s.card.id === "a")?.status).toBe("accepted");
    expect(out.find((s) => s.card.id === "b")?.status).toBe("ready");
    // No-op when the from-status doesn't match.
    expect(setCardStatus(out, "a", "ready", "accepted")).toEqual(out);
  });
});

describe("applyBatch", () => {
  it("applies refactor vs split per card and tallies skipped/failed", async () => {
    const proposals = [{ key: "back", before: "a", after: "A" }];
    const splitCards: RefactorFieldSet[] = [
      { type: "header-paragraph", front: "Q1", back: "A1" },
    ];
    const states: BatchCardState<TestCard>[] = [
      state("ref", "accepted", { mode: "refactor", proposals }),
      state("split", "accepted", { mode: "split", splitCards }),
      state("notready", "ready", { proposals }),
      state("fail", "accepted", { mode: "refactor", proposals }),
    ];

    const apply = jest.fn(async (c: TestCard) =>
      c.id === "fail" ? { ok: false, error: "boom" } : { ok: true },
    );
    const applySplit = jest.fn(async () => ({ ok: true }));

    const result = await applyBatch(states, { apply, applySplit });

    expect(result).toMatchObject({ applied: 2, skipped: 1, failed: 1 });
    // Refactor card → apply with its proposals.
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ref" }),
      proposals,
    );
    // Split card → applySplit with its cards.
    expect(applySplit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "split" }),
      splitCards,
    );
    // The failed card is marked error; the ready card is untouched.
    expect(result.states.find((s) => s.card.id === "fail")?.status).toBe("error");
    expect(result.states.find((s) => s.card.id === "fail")?.error).toBe("boom");
    expect(result.states.find((s) => s.card.id === "notready")?.status).toBe("ready");
    // Original input array is not mutated.
    expect(states.find((s) => s.card.id === "fail")?.status).toBe("accepted");
  });
});
