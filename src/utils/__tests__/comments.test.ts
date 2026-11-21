import { fencedLines, findComments, replaceComments } from "../comments";

const strip = (text: string) => replaceComments(text, () => "");

describe("Obsidian comments", () => {
  it("finds inline and multi-line comments", () => {
    expect(findComments("a %%x%% b %%\ny\n%%").map((span) => span.inner)).toEqual(["x", "\ny\n"]);
    expect(strip("a %%x%% b")).toBe("a  b");
    expect(findComments("no comments")).toEqual([]);
  });

  it("leaves %% inside fenced code alone", () => {
    const diagram = "```mermaid\nflowchart LR\n%% one\nA --> B\n%% two\n```";
    expect(strip(`a %%x%%\n${diagram}\n%%y%%b`)).toBe(`a \n${diagram}\nb`);
    expect(strip("~~~\n%%x%%\n~~~\n%%y%%")).toBe("~~~\n%%x%%\n~~~\n");
    expect(strip("a\n```\n%% never closed")).toBe("a\n```\n%% never closed");
  });

  it("drops a comment that wraps a whole code block", () => {
    expect(strip("a\n%%\n```js\nx\n```\n%%\nb")).toBe("a\n\nb");
  });

  it("marks fence lines and the code between them", () => {
    expect(fencedLines(["text", "```", "code", "```", "after"])).toEqual([false, true, true, true, false]);
  });
});
