import { buildMcqContent, buildMcqMarkdown, checkGeneratedMcq } from "../mcq";
import { classifyExamBody } from "../../ExamClassifier";
import { FlashcardParser } from "../../FlashcardParser";
import { DISTRACTOR_CODES, isDistractorCode } from "../critique-prompt";
import { fixActionFor } from "../fixes";
import type { GeneratedCard } from "../generation-prompt";

const q = (back: string, front = "Which measure shares the data's unit?", notes = ""): GeneratedCard =>
  ({ front, back, notes });

const GOOD = ["- [ ] Variance", "- [x] Standard deviation", "- [ ] Range", "- [ ] Coefficient of variation"].join("\n");

describe("checkGeneratedMcq", () => {
  it("reads a well-formed question", () => {
    const res = checkGeneratedMcq(q(GOOD, "Which measure shares the unit?", "The root restores it."));
    expect(res.valid).toBe(true);
    if (!res.valid) return;
    expect(res.mcq.options.map((o) => o.text)).toEqual([
      "Variance",
      "Standard deviation",
      "Range",
      "Coefficient of variation",
    ]);
    expect(res.mcq.correct).toEqual([1]);
    expect(res.mcq.explanation).toBe("The root restores it.");
  });

  it("reports several correct options as multi-select", () => {
    const res = checkGeneratedMcq(q("- [x] Helium\n- [ ] Oxygen\n- [x] Argon"));
    expect(res.valid && res.mcq.correct).toEqual([0, 2]);
  });

  it("rejects exactly what the exam setup dialog would skip", () => {
    // These are the classifier's own conditions, not a second opinion — a
    // question rejected here must be the same one the dialog counts as skipped.
    const cases: Array<[string, string]> = [
      ["- [ ] A\n- [ ] B", "no-correct-answer"],
      ["- [x] Only one", "single-option"],
      ["- [x] A\n- B plain bullet\n- [ ] C", "mixed-list"],
      ["- [x] A\n  - [ ] nested\n- [ ] C", "nested-task-list"],
      ["- [x] \n- [ ] B", "empty-option"],
    ];
    for (const [back, reason] of cases) {
      const res = checkGeneratedMcq(q(back));
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.reason).toBe(reason);
    }
  });

  it("tolerates an explanation the model left in the body", () => {
    // The classifier would read a stray %%comment%% as a plain bullet beside
    // the task items and call the question invalid.
    const res = checkGeneratedMcq(q(`${GOOD}\n\n%%The root restores the unit.%%`));
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.mcq.explanation).toBe("The root restores the unit.");
  });

  it("prefers the NOTES explanation over one left in the body", () => {
    const res = checkGeneratedMcq(
      q(`${GOOD}\n\n%%from the body%%`, "Which?", "from notes"),
    );
    expect(res.valid && res.mcq.explanation).toBe("from notes");
  });

  it("calls a card with no task list not-a-question", () => {
    const res = checkGeneratedMcq(q("The middle value of an ordered series."));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe("not-a-question");
  });

  it("folds body text above the list into the stem", () => {
    const res = checkGeneratedMcq(q(`Given the data below.\n\n${GOOD}`, "Spread"));
    expect(res.valid && res.mcq.stem).toBe("Spread\n\nGiven the data below.");
  });
});

describe("buildMcqMarkdown", () => {
  it("writes the heading and task list Decks parses back", () => {
    const md = buildMcqMarkdown(q(GOOD, "Which shares the unit?", "Why."), 2);
    expect(md.startsWith("## Which shares the unit?")).toBe(true);
    expect(md).toContain("- [x] Standard deviation");
    expect(md).toContain("%%Why.%%");

    // Round trip through the parser's own path: it lifts the comment out as
    // notes before classifying, and the classifier is written for that input.
    const body = md.split("\n").slice(1).join("\n").trim();
    const { back: stripped } = FlashcardParser.extractHeaderParagraphNotes(body);
    const back = classifyExamBody(stripped);
    expect(back.kind).toBe("mcq");
    if (back.kind === "mcq") {
      expect(back.options.filter((o) => o.correct).map((o) => o.text)).toEqual([
        "Standard deviation",
      ]);
    }
  });

  it("omits the comment when there is no explanation", () => {
    expect(buildMcqMarkdown(q(GOOD), 2)).not.toContain("%%");
  });

  it("keeps the source page in the comment, beside the explanation", () => {
    expect(buildMcqMarkdown({ ...q(GOOD, "Q?", "Why."), page: 70 }, 2)).toContain("%%Why.\n\np. 70%%");
    expect(buildMcqMarkdown({ ...q(GOOD), page: 12 }, 2)).toContain("%%p. 12%%");
  });

  it("collapses a multi-line stem into one heading line", () => {
    const md = buildMcqMarkdown(q(GOOD, "Line one\nline two"), 2);
    expect(md.split("\n")[0]).toBe("## Line one line two");
  });

  it("writes an invalid question through rather than dropping it", () => {
    // Saving it is the user's decision; omitting it silently would hide that
    // the question is broken.
    const md = buildMcqMarkdown(q("- [ ] A\n- [ ] B", "No answer marked"), 2);
    expect(md).toContain("No answer marked");
    expect(md).toContain("- [ ] A");
  });

  it("joins a document with a blank line between questions", () => {
    const doc = buildMcqContent([q(GOOD, "One"), q(GOOD, "Two")], 2);
    expect(doc).toContain("## One");
    expect(doc).toContain("## Two");
    expect(doc.split("## ").length).toBe(3);
  });
});

describe("distractor codes", () => {
  it("are distinguishable from card-quality codes", () => {
    expect(isDistractorCode("length_cue")).toBe(true);
    expect(isDistractorCode("enumeration")).toBe(false);
  });

  it("each offer an option fix — the options are what is wrong", () => {
    const own: Record<string, string> = {
      length_cue: "even_out",
      implausible_distractor: "replace_distractor",
    };
    for (const code of DISTRACTOR_CODES) {
      expect(fixActionFor([code])).toBe(own[code] ?? "rewrite");
    }
  });

  it("rewrites when two different option fixes are asked for at once", () => {
    expect(fixActionFor(["length_cue", "implausible_distractor"])).toBe("rewrite");
    expect(fixActionFor(["length_cue", "length_cue"])).toBe("even_out");
  });
});
