import {
  insertAfter,
  isRefinement,
  lastResultBlock,
  localRowId,
  nextRowCounter,
  roundsByTurn,
  threadFromTurns,
  pruneBlocks,
  supersededIds,
  type ThreadBlock,
} from "../thread";

const prompt = (id: string, text = "t"): ThreadBlock => ({
  kind: "prompt",
  id,
  text,
});
const result = (
  id: string,
  rowIds: string[],
  replacesId?: string,
): ThreadBlock => ({ kind: "result", id, rowIds, replacesId });

describe("isRefinement", () => {
  it("is a refinement only when an instruction arrives over an existing pile", () => {
    expect(isRefinement(true, "make them atomic")).toBe(true);
  });

  it("is not a refinement on the first round", () => {
    expect(isRefinement(false, "make cards")).toBe(false);
  });

  it("is not a refinement when the prompt is empty — that is Continue", () => {
    // Continue adds to the pile; a refinement replaces part of it. Treating
    // them alike would collapse a round the user only meant to extend.
    expect(isRefinement(true, "")).toBe(false);
    expect(isRefinement(true, "   ")).toBe(false);
  });
});

describe("lastResultBlock", () => {
  it("finds the most recent round, skipping prompts", () => {
    const blocks = [result("r1", ["a"]), prompt("p1"), result("r2", ["b"]), prompt("p2")];
    expect(lastResultBlock(blocks)?.id).toBe("r2");
  });

  it("is undefined when nothing has been generated", () => {
    expect(lastResultBlock([prompt("p1")])).toBeUndefined();
    expect(lastResultBlock([])).toBeUndefined();
  });

  it("skips a round that produced no cards", () => {
    // A failed refinement leaves an empty round; the next one refines the cards.
    const blocks = [result("r1", ["a"]), prompt("p1"), result("r2", [], "r1")];
    expect(lastResultBlock(blocks)?.id).toBe("r1");
  });

  it("skips a round with nothing left to refine", () => {
    // r2 is a captured answer and r3 is already saved; r1 still has open cards.
    const blocks = [result("r1", ["a", "b"]), result("r2", ["c"]), result("r3", ["d"])];
    const open = new Set(["b"]);
    expect(lastResultBlock(blocks, (id) => open.has(id))?.id).toBe("r1");
    expect(lastResultBlock(blocks, () => false)).toBeUndefined();
  });
});

describe("supersededIds", () => {
  it("names the block a refinement replaced", () => {
    const blocks = [result("r1", ["a"]), result("r2", ["b"], "r1")];
    expect([...supersededIds(blocks)]).toEqual(["r1"]);
  });

  it("is empty when every round stands on its own", () => {
    expect(supersededIds([result("r1", ["a"]), result("r2", ["b"])]).size).toBe(0);
  });

  it("does not mark the replacement itself", () => {
    // The newest round is the live one; collapsing it would hide the result the
    // user just asked for.
    const ids = supersededIds([result("r1", ["a"]), result("r2", ["b"], "r1")]);
    expect(ids.has("r2")).toBe(false);
  });

  it("keeps a round whose replacement produced no cards", () => {
    // Refused, stopped or empty: the earlier cards stay live and saveable.
    expect(supersededIds([result("r1", ["a"]), result("r2", [], "r1")]).size).toBe(0);
  });

  it("follows a chain of refinements", () => {
    const blocks = [
      result("r1", ["a"]),
      result("r2", ["b"], "r1"),
      result("r3", ["c"], "r2"),
    ];
    expect([...supersededIds(blocks)].sort()).toEqual(["r1", "r2"]);
  });
});

describe("insertAfter", () => {
  it("places a fix's children directly after the row they replaced", () => {
    expect(insertAfter(["a", "b", "c"], "b", ["b1", "b2"])).toEqual([
      "a",
      "b",
      "b1",
      "b2",
      "c",
    ]);
  });

  it("leaves the list alone when the parent is not in this block", () => {
    expect(insertAfter(["a", "b"], "zz", ["x"])).toEqual(["a", "b"]);
  });
});

describe("pruneBlocks", () => {
  it("drops a round that produced nothing", () => {
    const blocks = [result("r1", ["a"]), result("r2", [])];
    expect(pruneBlocks(blocks, new Set(["a"])).map((b) => b.id)).toEqual(["r1"]);
  });

  it("keeps the prompts that framed the rounds", () => {
    // The instruction was still given, and the thread is a record of what was
    // asked as much as of what came back.
    const blocks = [prompt("p1"), result("r1", [])];
    expect(pruneBlocks(blocks, new Set()).map((b) => b.id)).toEqual(["p1"]);
  });

  it("keeps a round while any of its rows survive, without the gone ones", () => {
    const blocks = [result("r1", ["a", "b"])];
    const kept = pruneBlocks(blocks, new Set(["b"]));
    expect(kept.map((b) => b.id)).toEqual(["r1"]);
    // A cleared row left in its round would be recorded, and come back on reopen.
    expect(kept[0]).toMatchObject({ rowIds: ["b"] });
  });
});

describe("restoring a pile", () => {
  it("keeps a stored row's own id, so writing it again replaces it", () => {
    expect(localRowId("s1", "s1:gen-3")).toBe("gen-3");
    expect(localRowId("s1", "s1:res-0")).toBe("res-0");
  });

  it("leaves an id that carries no session prefix alone", () => {
    expect(localRowId("s1", "gen-3")).toBe("gen-3");
  });

  it("numbers new rows past every restored one", () => {
    // A counter set to the row count would reuse gen-5 here and overwrite it.
    expect(nextRowCounter(["gen-0", "gen-5", "res-2"])).toBe(6);
    expect(nextRowCounter([])).toBe(0);
    expect(nextRowCounter(["res-0", "res-1"])).toBe(0);
  });
});

describe("the thread through the turn log", () => {
  const turnsFor = (blocks: ThreadBlock[]) => {
    const rounds = roundsByTurn(blocks);
    return blocks
      .filter((b) => b.kind !== "result")
      .map((b, i) => ({
        role: b.kind === "prompt" ? ("user" as const) : ("assistant" as const),
        text: b.kind === "result" ? "" : b.text,
        at: "t",
        rounds: rounds[i],
      }));
  };
  const counter = () => {
    let n = 0;
    return () => `b${n++}`;
  };

  it("brings rounds back with what they replaced", () => {
    const blocks = [
      prompt("p1", "Cards"),
      result("r1", ["a", "b"]),
      prompt("p2", "Shorter"),
      result("r2", ["c"], "r1"),
    ];
    const back = threadFromTurns(turnsFor(blocks), ["a", "b", "c"], counter());
    const rounds = back.filter((b) => b.kind === "result");
    expect(rounds.map((b) => b.rowIds)).toEqual([["a", "b"], ["c"]]);
    // The replaced round stays replaced, so Save does not offer it again.
    expect(supersededIds(back).has(rounds[0].id)).toBe(true);
  });

  it("keeps a cleared card out", () => {
    const blocks = [prompt("p1"), result("r1", ["a"]), prompt("p2"), result("r2", ["b"])];
    const turns = turnsFor(pruneBlocks(blocks, new Set(["b"])));
    const back = threadFromTurns(turns, ["a", "b"], counter());
    expect(back.filter((b) => b.kind === "result").map((b) => b.rowIds)).toEqual([["b"]]);
  });

  it("puts a log from before rounds were recorded back as one round", () => {
    const turns = [{ role: "user" as const, text: "Cards", at: "t" }];
    const back = threadFromTurns(turns, ["a", "b"], counter());
    expect(back.map((b) => b.kind)).toEqual(["prompt", "result"]);
    expect(back.filter((b) => b.kind === "result").map((b) => b.rowIds)).toEqual([["a", "b"]]);
  });

  it("brings back a card staged from elsewhere, but not a cleared one", () => {
    // A reader capture is stored without a round; a cleared card was discarded.
    const blocks = [prompt("p1"), result("r1", ["a"])];
    const back = threadFromTurns(turnsFor(blocks), ["a", "cap", "gone"], counter(), new Set(["a", "cap"]));
    expect(back.filter((b) => b.kind === "result").map((b) => b.rowIds)).toEqual([["a"], ["cap"]]);
  });

  it("drops the rounds of a row that is gone", () => {
    const blocks = [prompt("p1"), result("r1", ["a"])];
    const back = threadFromTurns(turnsFor(blocks), [], counter());
    expect(back.map((b) => b.kind)).toEqual(["prompt"]);
  });
});
