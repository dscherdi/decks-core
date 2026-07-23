import { toSpeechText } from "../toSpeechText";

describe("toSpeechText", () => {
  it("returns empty string for empty input", () => {
    expect(toSpeechText("")).toBe("");
  });

  it("strips emphasis and inline code markers", () => {
    expect(toSpeechText("**bold** and *italic* and `code`")).toBe(
      "bold and italic and code"
    );
  });

  it("strips heading, blockquote, and list markers", () => {
    expect(toSpeechText("# Title\n> quote\n- item one\n1. item two")).toBe(
      "Title quote item one item two"
    );
  });

  it("keeps wikilink labels and drops embeds", () => {
    expect(toSpeechText("See [[Note A|the note]] and ![[image.png]] here")).toBe(
      "See the note and here"
    );
  });

  it("uses the last path segment for bare wikilinks", () => {
    expect(toSpeechText("[[folder/sub/Target]]")).toBe("Target");
  });

  it("keeps markdown link text and drops the url", () => {
    expect(toSpeechText("[label](https://example.com)")).toBe("label");
  });

  it("strips inline HTML tags", () => {
    expect(toSpeechText("a <span class='x'>b</span> c")).toBe("a b c");
  });

  it("keeps cloze answer text by default", () => {
    expect(toSpeechText("The capital is ==Paris==.")).toBe(
      "The capital is Paris."
    );
  });

  it("masks cloze answers when requested", () => {
    expect(
      toSpeechText("The capital is ==Paris==.", { maskCloze: true })
    ).toBe("The capital is blank .");
  });

  it("supports a custom cloze placeholder", () => {
    expect(
      toSpeechText("==x== then ==y==", {
        maskCloze: true,
        clozePlaceholder: "gap",
      })
    ).toBe("gap then gap");
  });

  it("collapses whitespace across lines", () => {
    expect(toSpeechText("line one\n\n   line two")).toBe("line one line two");
  });
});
