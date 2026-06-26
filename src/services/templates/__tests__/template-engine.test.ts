import { parseTemplateFile } from "../TemplateFileParser";
import { resolveCardTemplate } from "../TemplateBinding";
import { FlashcardParser } from "../../FlashcardParser";
import type { DeckTemplate, TemplateRow } from "../../../database/types";

function template(over: Partial<DeckTemplate>): DeckTemplate {
  return {
    id: "t1",
    sourceFile: "Templates/A.md",
    tags: [],
    frontTemplate: "{{Word}}",
    frontType: "md",
    backTemplate: "{{Definition}}",
    backType: "md",
    notesTemplate: null,
    notesType: null,
    created: "",
    modified: "",
    ...over,
  };
}

describe("TemplateFileParser", () => {
  it("parses per-side codeblocks with their engine", () => {
    const content = [
      "---",
      "tags: [chemistry]",
      "---",
      "```decks-html-front",
      "<b>{{Word}}</b>",
      "```",
      "```decks-md-back",
      "{{Definition}}",
      "```",
    ].join("\n");
    const set = parseTemplateFile(content);
    expect(set?.front).toEqual({ engine: "html", template: "<b>{{Word}}</b>" });
    expect(set?.back).toEqual({ engine: "md", template: "{{Definition}}" });
  });

  it("falls back to a markdown horizontal-rule split", () => {
    const content = [
      "---",
      "tags: [vocab]",
      "---",
      "# {{Word}}",
      "",
      "---",
      "",
      "Definition: {{Definition}}",
    ].join("\n");
    const set = parseTemplateFile(content);
    expect(set?.front).toEqual({ engine: "md", template: "# {{Word}}" });
    expect(set?.back).toEqual({ engine: "md", template: "Definition: {{Definition}}" });
  });

  it("returns null when there is no codeblock and no horizontal rule", () => {
    expect(parseTemplateFile("just some text\nno rule")).toBeNull();
  });
});

describe("resolveCardTemplate (header-tag binding)", () => {
  const row: TemplateRow = {
    headers: ["Word", "Definition"],
    cells: ["Bonjour", "Hello"],
  };

  it("binds via a header tag (Tier 1) and merges cells", () => {
    const templates = [template({ tags: ["chemistry"], frontTemplate: "<b>{{Word}}</b>", frontType: "html" })];
    const resolved = resolveCardTemplate(["chemistry"], [], row, templates);
    expect(resolved).toEqual({
      front: "<b>Bonjour</b>",
      frontType: "html",
      back: "Hello",
      backType: "md",
    });
  });

  it("binds via a file tag (Tier 2) when no header tag matches", () => {
    const templates = [template({ tags: ["biology"] })];
    const resolved = resolveCardTemplate([], ["#biology"], row, templates);
    expect(resolved?.front).toBe("Bonjour");
  });

  it("prefers the header tag over the file tag", () => {
    const templates = [
      template({ id: "h", sourceFile: "Templates/Header.md", tags: ["chemistry"], frontTemplate: "HEAD {{Word}}" }),
      template({ id: "f", sourceFile: "Templates/File.md", tags: ["biology"], frontTemplate: "FILE {{Word}}" }),
    ];
    const resolved = resolveCardTemplate(["chemistry"], ["#biology"], row, templates);
    expect(resolved?.front).toBe("HEAD Bonjour");
  });

  it("breaks ties by most tags matched, then source_file A–Z", () => {
    const templates = [
      template({ id: "one", sourceFile: "Z.md", tags: ["a"], frontTemplate: "ONE" }),
      template({ id: "two", sourceFile: "Y.md", tags: ["a", "b"], frontTemplate: "TWO" }),
      template({ id: "three", sourceFile: "X.md", tags: ["a", "b"], frontTemplate: "THREE" }),
    ];
    expect(resolveCardTemplate(["a", "b"], [], row, templates)?.front).toBe("THREE");
  });

  it("returns null when nothing matches or there is no row", () => {
    expect(resolveCardTemplate(["x"], [], row, [template({ tags: ["unrelated"] })])).toBeNull();
    expect(resolveCardTemplate(["chemistry"], [], null, [template({ tags: ["chemistry"] })])).toBeNull();
  });
});

describe("Parsing template flashcards end-to-end", () => {
  // Tag lives on the HEADER that contains the table (not in a cell).
  const file = [
    "## Vocabulary #vocab",
    "",
    "| Word | Reading | Meaning |",
    "| --- | --- | --- |",
    "| 火 | ひ | fire |",
    "| 水 | みず | water |",
  ].join("\n");

  it("captures templateRow and inherits the header tag onto card.tags", () => {
    const cards = FlashcardParser.parseFlashcardsFromContent(file, 2);
    expect(cards).toHaveLength(2);
    expect(cards[0].type).toBe("table");
    expect(cards[0].tags).toContain("vocab");
    expect(cards[0].templateRow).toEqual({
      headers: ["Word", "Reading", "Meaning"],
      cells: ["火", "ひ", "fire"],
    });
    // No rowTags field — binding tags come from the header.
    expect((cards[0].templateRow as unknown as Record<string, unknown>).rowTags).toBeUndefined();
  });

  it("resolves the header tag to a template and merges named + positional vars", () => {
    const cards = FlashcardParser.parseFlashcardsFromContent(file, 2);
    const templates = [
      template({
        tags: ["vocab"],
        frontTemplate: "<ruby>{{Word}}<rt>{{Reading}}</rt></ruby>",
        frontType: "html",
        backTemplate: "{{3}}",
        backType: "md",
      }),
    ];
    const resolved = resolveCardTemplate(cards[0].tags, [], cards[0].templateRow, templates);
    expect(resolved).toEqual({
      front: "<ruby>火<rt>ひ</rt></ruby>",
      frontType: "html",
      back: "fire",
      backType: "md",
    });
  });

  it("captures templateRow for table rows even when cloze is enabled (no markers)", () => {
    // The default profile has clozeEnabled=true; a marker-less table row must
    // still carry templateRow so it can bind a template at render time.
    const cards = FlashcardParser.parseFlashcardsFromContent(file, 2, undefined, true);
    expect(cards).toHaveLength(2);
    expect(cards[0].type).toBe("table");
    expect(cards[0].templateRow).toEqual({
      headers: ["Word", "Reading", "Meaning"],
      cells: ["火", "ひ", "fire"],
    });
  });

  it("does not attach templateRow to header-paragraph cards", () => {
    const md = ["## What is osmosis?", "", "Movement of solvent across a membrane."].join("\n");
    const cards = FlashcardParser.parseFlashcardsFromContent(md, 2);
    expect(cards[0].type).toBe("header-paragraph");
    expect(cards[0].templateRow).toBeUndefined();
  });
});
