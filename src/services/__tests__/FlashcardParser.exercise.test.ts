import { FlashcardParser } from "../FlashcardParser";
import { classifyExamBody } from "../ExamClassifier";

const parse = (content: string, examEnabled = true, levels: number | number[] = 2, clozeEnabled = false) =>
  FlashcardParser.parseFlashcardsFromContent(content, levels, undefined, clozeEnabled, examEnabled);

const FORM_B = [
  "## Der TV-Koch Stefan Berger",
  "Sie lesen in einer Zeitung diesen Text. ![[berger.jpg]]",
  "Bei Stefan Berger gibt es Gerichte.",
  "",
  "Die Gäste im Lokal …",
  "- [ ] finden immer einen Tisch.",
  "- [x] sollen Plätze reservieren.",
  "%%Reservieren is in the text.%%",
  "",
  "Stefan Berger möchte …",
  "- [x] nur ein Restaurant haben.",
  "- [ ] ein neues Restaurant eröffnen.",
  "%%dk:q:0a6j4mka7%%",
].join("\n");

const FORM_A = [
  "# Lesen",
  "Ein Übungstest. Diese Einleitung ist kein Teil der Aufgaben.",
  "",
  "## Lesen Teil 1",
  "Sie lesen in einer Zeitung diesen Text.",
  "> [!passage] Der TV-Koch Stefan Berger",
  "> Bei Stefan Berger gibt es Gerichte.",
  "",
  "### Die Gäste im Lokal …",
  "- [ ] finden immer einen Tisch.",
  "- [x] sollen Plätze reservieren.",
  "%%Steht im Text.%%",
  "",
  "### Stefan Berger möchte …",
  "- [x] nur ein Restaurant haben.",
  "- [ ] ein neues Restaurant eröffnen.",
  "",
  "## Was ist das Gegenteil von alt?",
  "- [x] neu",
  "- [ ] groß",
].join("\n");

describe("FlashcardParser exercises (one heading)", () => {
  it("parses several checklists under one heading as one multiple-choice card", () => {
    const cards = parse(FORM_B);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("multiple-choice");
    expect(cards[0].front).toBe("Der TV-Koch Stefan Berger");
    expect(cards[0].anchorKey).toBeDefined();
  });

  it("keeps each question's comment in the body for the exam to read", () => {
    const [card] = parse(FORM_B);
    expect(card.back).toContain("%%Reservieren is in the text.%%");
    expect(card.back).not.toContain("dk:");
    const classified = classifyExamBody(card.back);
    expect(classified.kind).toBe("exercise");
    if (classified.kind !== "exercise") return;
    expect(classified.items[0].notes).toBe("Reservieren is in the text.");
    expect(card.notes).toBe("");
  });

  it("stays a plain card with notes when exams are off", () => {
    const [card] = parse(FORM_B, false);
    expect(card.type).toBe("header-paragraph");
    expect(card.notes).toContain("Reservieren is in the text.");
  });

  it("keeps the id input the same as without exams", () => {
    expect(parse(FORM_B)[0].front).toBe(parse(FORM_B, false)[0].front);
  });
});

describe("FlashcardParser exercises (question headings)", () => {
  it("keeps deeper headings with checklists in the card above them, as its questions", () => {
    const cards = parse(FORM_A);
    expect(cards.map((c) => [c.type, c.front])).toEqual([
      ["multiple-choice", "Lesen Teil 1"],
      ["multiple-choice", "Was ist das Gegenteil von alt?"],
    ]);
    const classified = classifyExamBody(cards[0].back);
    expect(classified.kind).toBe("exercise");
    if (classified.kind !== "exercise") return;
    expect(classified.shared).toBe(
      "Sie lesen in einer Zeitung diesen Text.\n> [!passage] Der TV-Koch Stefan Berger\n> Bei Stefan Berger gibt es Gerichte."
    );
    expect(classified.items.map((item) => item.stem)).toEqual(["Die Gäste im Lokal …", "Stefan Berger möchte …"]);
    expect(classified.items[0].notes).toBe("Steht im Text.");
  });

  it("never makes a title heading's text part of a card", () => {
    expect(parse(FORM_A).some((card) => card.back.includes("Einleitung"))).toBe(false);
  });

  it("leaves a single deeper heading alone", () => {
    const cards = parse(["## Question", "The answer.", "### Hint", "Think of Paris."].join("\n"));
    expect(cards).toHaveLength(1);
    expect(cards[0].back).toBe("The answer.");
    const one = parse(["## Exercise", "Text", "### Only question", "- [x] A", "- [ ] B"].join("\n"));
    expect(one).toHaveLength(1);
    expect(one[0].back).toBe("Text");
  });

  it("does not take a heading at a parsed level as a question", () => {
    const cards = parse(FORM_A, true, [2, 3]);
    expect(cards.map((c) => c.front)).toContain("Die Gäste im Lokal …");
  });

  it("with several parsed levels, takes the next unparsed level below a card as its questions", () => {
    const note = [
      "## Lesen",
      "Allgemeine Hinweise.",
      "### Teil 1",
      "Ein Text.",
      "#### Frage A",
      "- [x] ja",
      "- [ ] nein",
      "#### Frage B",
      "Antwort B",
      "### Teil 2",
      "Antwort zu Teil 2",
    ].join("\n");
    const cards = parse(note, true, [2, 3]);
    expect(cards.map((c) => [c.front, c.type])).toEqual([
      ["Lesen", "header-paragraph"],
      ["Teil 1", "multiple-choice"],
      ["Teil 2", "header-paragraph"],
    ]);
    expect(cards[1].back).toContain("#### Frage B");
  });

  it("with parsed levels apart, the level between them holds questions", () => {
    const note = ["## Aufgabe", "Text", "### Q1", "- [x] A", "- [ ] B", "### Q2", "B", "#### Card", "answer"].join("\n");
    const cards = parse(note, true, [2, 4]);
    expect(cards.map((c) => [c.front, c.type])).toEqual([
      ["Aufgabe", "multiple-choice"],
      ["Card", "header-paragraph"],
    ]);
  });

  it("takes any deeper heading below the card as a question", () => {
    const cards = parse(["## Aufgabe", "Text", "### Q1", "- [x] A", "- [ ] B", "##### Q2", "B"].join("\n"));
    expect(cards).toHaveLength(1);
    const classified = classifyExamBody(cards[0].back);
    expect(classified.kind === "exercise" && classified.items.map((item) => item.stem)).toEqual(["Q1", "Q2"]);
  });

  it("keeps typed and fill-in questions in an exercise", () => {
    const cards = parse(["## Aufgabe", "Text", "### Preis?", "12 Euro", "### Ergänze", "Um ==8== Uhr."].join("\n"));
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("multiple-choice");
  });

  it("keeps a table in the text instead of reading it as rows", () => {
    const cards = parse(
      ["## Öffnungszeiten", "| Tag | Zeit |", "|---|---|", "| Mo | 8–18 |", "### Q1", "- [x] A", "- [ ] B", "### Q2", "- [x] C", "- [ ] D"].join("\n")
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe("multiple-choice");
  });

  it("parses headings as an ordinary card when exams are off", () => {
    const cards = parse(FORM_A, false);
    expect(cards.map((c) => c.type)).toEqual(["header-paragraph", "header-paragraph"]);
    expect(cards[0].back).not.toContain("###");
  });
});
