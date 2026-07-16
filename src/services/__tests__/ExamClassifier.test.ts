import { classifyExamBody } from "../ExamClassifier";

const mcq = (back: string) => {
  const result = classifyExamBody(back);
  if (result.kind !== "mcq") throw new Error(`expected mcq, got ${result.kind}`);
  return result;
};

const invalid = (back: string) => {
  const result = classifyExamBody(back);
  if (result.kind !== "invalid") throw new Error(`expected invalid, got ${result.kind}`);
  return result;
};

describe("classifyExamBody", () => {
  it("classifies a single-answer question (radio)", () => {
    const r = mcq(["- [ ] Oxygen", "- [x] Argon", "- [ ] Nitrogen"].join("\n"));
    expect(r.options).toEqual([
      { text: "Oxygen", correct: false },
      { text: "Argon", correct: true },
      { text: "Nitrogen", correct: false },
    ]);
    expect(r.stem).toBe("");
  });

  it("classifies a multi-select question (2+ checked)", () => {
    const r = mcq(["- [x] Helium", "- [ ] Oxygen", "- [x] Argon"].join("\n"));
    expect(r.options.filter((o) => o.correct)).toHaveLength(2);
  });

  it("accepts all boxes checked (degenerate multi-select)", () => {
    const r = mcq(["- [x] A", "- [X] B"].join("\n"));
    expect(r.options.every((o) => o.correct)).toBe(true);
  });

  it("extracts non-list content above the list as the stem", () => {
    const r = mcq(
      ["Some context.", "![[heart.png]]", "", "- [x] Left ventricle", "- [ ] Aorta"].join("\n")
    );
    expect(r.stem).toBe("Some context.\n![[heart.png]]");
  });

  it("keeps indented non-task lines as option continuation markdown", () => {
    const r = mcq(
      ["- [x] Argon", "  extra detail line", "- [ ] Oxygen"].join("\n")
    );
    expect(r.options[0].text).toBe("Argon\nextra detail line");
  });

  it("accepts * and + bullets and capital X", () => {
    const r = mcq(["* [X] A", "+ [ ] B"].join("\n"));
    expect(r.options[0].correct).toBe(true);
  });

  it("flags a task list with no box checked", () => {
    expect(invalid(["- [ ] A", "- [ ] B"].join("\n")).reason).toBe("no-correct-answer");
  });

  it("flags a single task item", () => {
    expect(invalid("- [x] Only").reason).toBe("single-option");
  });

  it("flags a mixed top-level list", () => {
    expect(invalid(["- [x] A", "- plain bullet", "- [ ] B"].join("\n")).reason).toBe(
      "mixed-list"
    );
  });

  it("flags a plain bullet directly adjacent above the task list", () => {
    expect(invalid(["- plain", "- [x] A", "- [ ] B"].join("\n")).reason).toBe("mixed-list");
  });

  it("allows a stem bullet list separated by a blank line", () => {
    const r = mcq(["- stem point", "", "- [x] A", "- [ ] B"].join("\n"));
    expect(r.stem).toBe("- stem point");
  });

  it("flags nested task items", () => {
    expect(
      invalid(["- [x] A", "  - [ ] nested", "- [ ] B"].join("\n")).reason
    ).toBe("nested-task-list");
  });

  it("flags empty option text", () => {
    expect(invalid(["- [x] A", "- [ ]"].join("\n")).reason).toBe("empty-option");
  });

  it("flags top-level paragraph text after the list as mixed", () => {
    expect(invalid(["- [x] A", "- [ ] B", "trailing text"].join("\n")).reason).toBe(
      "mixed-list"
    );
  });

  it("ignores trailing thematic breaks (section separators)", () => {
    const r = mcq(["- [x] A", "- [ ] B", "", "---"].join("\n"));
    expect(r.options).toHaveLength(2);
  });

  it("returns plain for a body without top-level task items", () => {
    expect(classifyExamBody("Just a paragraph answer.").kind).toBe("plain");
    expect(classifyExamBody(["- bullet", "- list"].join("\n")).kind).toBe("plain");
    expect(classifyExamBody("").kind).toBe("plain");
  });

  it("treats custom checkbox states as plain bullets (mixed when task items exist)", () => {
    expect(invalid(["- [x] A", "- [?] custom", "- [ ] B"].join("\n")).reason).toBe(
      "mixed-list"
    );
  });
});
