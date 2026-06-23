import { AnkiSanitizer } from "../AnkiSanitizer";

describe("AnkiSanitizer", () => {
  it("converts [sound:…] to an embed and collects the media", () => {
    const result = AnkiSanitizer.sanitizeField("[sound:Firetongues-0082.mp3]");
    expect(result.text).toBe("![[Firetongues-0082.mp3]]");
    expect(result.media).toEqual(["Firetongues-0082.mp3"]);
  });

  it("converts <img src> to an embed and collects the media", () => {
    const result = AnkiSanitizer.sanitizeField('<img src="Firetongues-0082.jpg">');
    expect(result.text).toBe("![[Firetongues-0082.jpg]]");
    expect(result.media).toEqual(["Firetongues-0082.jpg"]);
  });

  it("converts cloze deletions to ==highlight==", () => {
    const result = AnkiSanitizer.sanitizeField("Du trinkst {{c1::jeden Tag}} Bier.");
    expect(result.text).toBe("Du trinkst ==jeden Tag== Bier.");
  });

  it("relocates a cloze hint after the highlight", () => {
    const result = AnkiSanitizer.sanitizeField("Ich {{c1::gehe::verb}} nach Hause.");
    expect(result.text).toBe("Ich ==gehe== (hint: verb) nach Hause.");
  });

  it("converts MathJax delimiters to LaTeX dollar syntax", () => {
    expect(AnkiSanitizer.sanitizeField("\\(a^2 + b^2\\)").text).toBe("$a^2 + b^2$");
    expect(AnkiSanitizer.sanitizeField("\\[E=mc^2\\]").text).toBe("$$E=mc^2$$");
  });

  it("strips HTML, decodes entities, and keeps text", () => {
    const result = AnkiSanitizer.sanitizeField(
      'You must be drinking beer&nbsp;<b><span style="color: rgb(254,84,10);">every day</span></b>.'
    );
    expect(result.text).toBe("You must be drinking beer every day.");
    expect(result.media).toEqual([]);
  });

  it("turns block elements into newlines", () => {
    const result = AnkiSanitizer.sanitizeField("Line one<br>Line two<div>Line three</div>");
    expect(result.text).toBe("Line one\nLine two\nLine three");
  });

  it("drops <style> blocks entirely", () => {
    const result = AnkiSanitizer.sanitizeField("<style>.x{color:red}</style>Hello");
    expect(result.text).toBe("Hello");
  });
});
