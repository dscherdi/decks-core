import { FlashcardParser } from "../FlashcardParser";

// Code is literal: a mermaid block writes its own comments with `%%` and may open with `---` frontmatter.
describe("FlashcardParser card notes and fenced code", () => {
  const parse = (body: string) =>
    FlashcardParser.parseFlashcardsFromContent(["## Request path", body].join("\n"), 2);

  it("keeps %% inside a code block as code, not as a note", () => {
    const diagram = [
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "  %% one",
      "  B --> C",
      "  %% two",
      "  C --> D",
      "```",
    ].join("\n");
    const [card] = parse(diagram);
    expect(card.back).toBe(diagram);
    expect(card.notes ?? "").toBe("");
  });

  it("still makes notes of comments outside code, and of one that wraps a code block", () => {
    const [card] = parse(
      ["Answer %%a note%%", "```js", "x %% y %% z", "```", "%%", "```js", "hidden", "```", "%%"].join("\n")
    );
    expect(card.back).toBe("Answer \n```js\nx %% y %% z\n```");
    expect(card.notes).toBe("a note\n\n```js\nhidden\n```");
  });

  it("does not split off notes at a thematic break inside code", () => {
    const diagram = ["```mermaid", "---", "title: Flow", "---", "flowchart LR", "  A --> B", "```"].join("\n");
    const [card] = parse(diagram);
    expect(card.back).toBe(diagram);
    expect(card.notes ?? "").toBe("");

    const [split] = parse(["The answer", "", "---", "A note after the break"].join("\n"));
    expect(split.back).toBe("The answer");
    expect(split.notes).toBe("A note after the break");
  });
});
