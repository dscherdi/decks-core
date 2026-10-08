import { classifyExamBody, examQuestionCount } from "../ExamClassifier";

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

const exercise = (back: string) => {
  const result = classifyExamBody(back);
  if (result.kind !== "exercise") throw new Error(`expected exercise, got ${result.kind}`);
  return result;
};

describe("classifyExamBody exercises", () => {
  const berger = [
    "Sie lesen in einer Zeitung diesen Text.",
    "![[berger.jpg]]",
    "",
    "Bei Stefan Berger gibt es Gerichte.",
    "",
    "Die Gäste im Lokal …",
    "- [ ] finden immer einen Tisch.",
    "- [x] sollen Plätze reservieren.",
    "%%Reservieren is in the second paragraph.%%",
    "",
    "Stefan Berger möchte …",
    "- [x] nur ein Restaurant haben.",
    "- [ ] ein neues Restaurant eröffnen.",
  ].join("\n");

  it("splits shared material from the questions under it", () => {
    const r = exercise(berger);
    expect(r.shared).toBe(
      "Sie lesen in einer Zeitung diesen Text.\n![[berger.jpg]]\n\nBei Stefan Berger gibt es Gerichte."
    );
    expect(r.items.map((item) => item.stem)).toEqual([
      "Die Gäste im Lokal …",
      "Stefan Berger möchte …",
    ]);
    expect(r.items[0].options).toEqual([
      { text: "finden immer einen Tisch.", correct: false },
      { text: "sollen Plätze reservieren.", correct: true },
    ]);
    expect(r.items[1].options[0].correct).toBe(true);
  });

  it("gives a comment below a checklist to that question", () => {
    const r = exercise(berger);
    expect(r.items[0].notes).toBe("Reservieren is in the second paragraph.");
    expect(r.items[1].notes).toBe("");
    expect(r.notes).toBe("");
  });

  it("allows no shared material", () => {
    const r = exercise(["First?", "- [x] A", "- [ ] B", "", "Second?", "- [ ] C", "- [x] D"].join("\n"));
    expect(r.shared).toBe("");
    expect(r.items).toHaveLength(2);
  });

  it("takes everything between two checklists as the next question", () => {
    const r = exercise(
      ["Q1", "- [x] A", "- [ ] B", "", "![[chart.png]]", "", "What does the chart show?", "- [x] C", "- [ ] D"].join("\n")
    );
    expect(r.items[1].stem).toBe("![[chart.png]]\n\nWhat does the chart show?");
  });

  it("keeps shared tables, callouts and code blocks whole", () => {
    const r = exercise(
      [
        "> [!passage] Text",
        "> Line one",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "```",
        "code",
        "",
        "more code",
        "```",
        "Q1",
        "- [x] A",
        "- [ ] B",
        "Q2",
        "- [x] C",
        "- [ ] D",
      ].join("\n")
    );
    expect(r.shared).toBe("> [!passage] Text\n> Line one\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(r.items[0].stem).toBe("```\ncode\n\nmore code\n```\nQ1");
  });

  it("treats rules between questions as separators", () => {
    const r = exercise(["Q1", "- [x] A", "- [ ] B", "", "---", "", "Q2", "- [x] C", "- [ ] D"].join("\n"));
    expect(r.items.map((item) => item.stem)).toEqual(["Q1", "Q2"]);
  });

  it("reads text after a rule below the last checklist as the exercise note", () => {
    const r = exercise(["Q1", "- [x] A", "- [ ] B", "Q2", "- [x] C", "- [ ] D", "", "---", "Source: Goethe A1"].join("\n"));
    expect(r.notes).toBe("Source: Goethe A1");
  });

  it("keeps comments in the shared text and stems out of the rendered text", () => {
    const r = exercise(["Shared %%inline%% text", "%%block%%", "", "Q1", "- [x] A", "- [ ] B", "Q2", "- [x] C", "- [ ] D"].join("\n"));
    expect(r.shared).toBe("Shared  text");
    expect(r.notes).toBe("inline\n\nblock");
  });

  it("ignores anchor comments", () => {
    const r = exercise(["Q1", "- [x] A", "- [ ] B", "%%dk:q:0a6j4mka7%%", "Q2", "- [x] C", "- [ ] D"].join("\n"));
    expect(r.items[0].notes).toBe("");
  });

  it("keeps option continuation lines", () => {
    const r = exercise(["Q1", "- [x] A", "  more of A", "- [ ] B", "Q2", "- [x] C", "- [ ] D"].join("\n"));
    expect(r.items[0].options[0].text).toBe("A\nmore of A");
  });

  it("flags a checklist with no question above it", () => {
    expect(invalid(["- [x] A", "- [ ] B", "Q2", "- [x] C", "- [ ] D"].join("\n")).reason).toBe("empty-question");
  });

  it("flags an invalid sub-question with its own reason", () => {
    expect(invalid(["Q1", "- [x] A", "- [ ] B", "Q2", "- [ ] C", "- [ ] D"].join("\n")).reason).toBe("no-correct-answer");
    expect(invalid(["Q1", "- [x] A", "- [ ] B", "Q2", "- [x] C"].join("\n")).reason).toBe("single-option");
    expect(invalid(["Q1", "- [x] A", "- [ ] B", "Q2", "- [x] C", "  - [ ] nested", "- [ ] D"].join("\n")).reason).toBe("nested-task-list");
  });

  it("flags text after the last checklist without a rule", () => {
    expect(invalid(["Q1", "- [x] A", "- [ ] B", "Q2", "- [x] C", "- [ ] D", "closing text"].join("\n")).reason).toBe("mixed-list");
  });

  it("leaves a single checklist a plain question", () => {
    expect(classifyExamBody(["Stem", "- [x] A", "- [ ] B"].join("\n")).kind).toBe("mcq");
  });

  it("counts the questions a body holds", () => {
    expect(examQuestionCount(berger)).toBe(2);
    expect(examQuestionCount(["- [x] A", "- [ ] B"].join("\n"))).toBe(1);
    expect(examQuestionCount("plain")).toBe(0);
  });

  it("reads question headings as the questions, with the text before the first as shared", () => {
    const r = exercise(
      ["Text", "", "### Q1", "Which one?", "- [x] A", "- [ ] B", "%%why%%", "", "---", "", "### Q2", "- [x] C", "- [ ] D"].join("\n")
    );
    expect(r.shared).toBe("Text");
    expect(r.items.map((item) => item.stem)).toEqual(["Q1\n\nWhich one?", "Q2"]);
    expect(r.items[0].notes).toBe("why");
  });

  it("reads a heading over text as a typed answer, and over highlights as blanks to fill", () => {
    const r = exercise(
      [
        "Lies den Text.",
        "### Was kostet das Ticket?",
        "12 Euro",
        "%%Steht in Zeile 2.%%",
        "#### Ergänze",
        "Der Zug fährt um ==8 Uhr== ab, Gleis ==3==.",
        "### Wann?",
        "- [x] morgens",
        "- [ ] abends",
      ].join("\n")
    );
    expect(r.items.map((item) => item.kind)).toEqual(["typed", "cloze", "choice"]);
    expect(r.items[0]).toMatchObject({ stem: "Was kostet das Ticket?", answer: "12 Euro", notes: "Steht in Zeile 2." });
    expect(r.items[1]).toMatchObject({ stem: "Ergänze", text: "Der Zug fährt um ==8 Uhr== ab, Gleis ==3==." });
    expect(examQuestionCount(["### A", "x", "### B", "==y== and ==z=="].join("\n"))).toBe(3);
  });

  it("needs no checklist when the questions are headings", () => {
    const r = exercise(["### Eins", "one", "### Zwei", "two"].join("\n"));
    expect(r.items.map((item) => item.kind)).toEqual(["typed", "typed"]);
  });

  it("is not an exercise with a single question heading", () => {
    expect(classifyExamBody(["Text", "### Q1", "- [x] A", "- [ ] B"].join("\n")).kind).toBe("mcq");
  });

  it("reads text after a rule at the end as the exercise note", () => {
    const r = exercise(["### Eins", "one", "### Zwei", "two", "", "---", "Quelle: Goethe"].join("\n"));
    expect(r.notes).toBe("Quelle: Goethe");
    expect(r.items[1]).toMatchObject({ answer: "two" });
  });

  it("flags a question heading with nothing under it, text after a checklist, and a checklist before any heading", () => {
    expect(invalid(["### Q1", "### Q2", "- [x] A", "- [ ] B"].join("\n")).reason).toBe("empty-answer");
    expect(invalid(["### Q1", "- [x] A", "- [ ] B", "trailing", "### Q2", "x"].join("\n")).reason).toBe("mixed-list");
    expect(invalid(["Text", "- [x] A", "- [ ] B", "### Q2", "- [x] C", "- [ ] D"].join("\n")).reason).toBe("empty-question");
    expect(invalid(["### Q1", "- [ ] A", "- [ ] B", "### Q2", "x"].join("\n")).reason).toBe("no-correct-answer");
  });

  it("ignores headings inside a code block", () => {
    expect(classifyExamBody(["```", "### not a heading", "```", "- [x] A", "- [ ] B"].join("\n")).kind).toBe("mcq");
  });
});
