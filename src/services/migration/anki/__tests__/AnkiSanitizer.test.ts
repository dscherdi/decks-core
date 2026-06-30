import { AnkiSanitizer } from "../AnkiSanitizer";

describe("AnkiSanitizer", () => {
  it("neutralizes Anki [[…]] so it isn't a broken wikilink (drops a leading tag::)", () => {
    expect(AnkiSanitizer.sanitizeField("[[r::{{c1::Paris}}]]").text).toBe("==Paris==");
    expect(AnkiSanitizer.sanitizeField("see [[Some Note]] here").text).toBe("see Some Note here");
    expect(AnkiSanitizer.sanitizeField("[[r::[$]\\Omega[/$]]] {{c1::x}}").text).toBe("$\\Omega$ ==x==");
  });

  it("leaves real media embeds (![[…]]) untouched by the wikilink guard", () => {
    expect(AnkiSanitizer.sanitizeField('<img src="a.png">').text).toBe("![[a.png]]");
  });

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

  it("keeps the full filename when the <img src> contains spaces", () => {
    const result = AnkiSanitizer.sanitizeField('<img src="1st Order Rate Law.png" />');
    expect(result.text).toBe("![[1st Order Rate Law.png]]");
    expect(result.media).toEqual(["1st Order Rate Law.png"]);
  });

  it("handles single-quoted and unquoted src", () => {
    expect(AnkiSanitizer.sanitizeField("<img src='a b.png'>").text).toBe("![[a b.png]]");
    expect(AnkiSanitizer.sanitizeField("<img src=z.png>").text).toBe("![[z.png]]");
  });

  it("gives two different spaced-filename images distinct embeds", () => {
    const result = AnkiSanitizer.sanitizeField(
      '<img src="1st Order Rate Law.png"> <img src="1st Order Integrated Rate Law.png">'
    );
    expect(result.text).toBe("![[1st Order Rate Law.png]] ![[1st Order Integrated Rate Law.png]]");
    expect(result.media).toEqual(["1st Order Rate Law.png", "1st Order Integrated Rate Law.png"]);
  });

  it("renders external <img> URLs as plain markdown images (not vault embeds)", () => {
    const result = AnkiSanitizer.sanitizeField('<img src="http://example.com/logo.gif">');
    expect(result.text).toBe("![](http://example.com/logo.gif)");
    expect(result.media).toEqual([]); // not a vault file → not copied
  });

  it("adds a width hint from the image's intrinsic size", () => {
    const result = AnkiSanitizer.sanitizeField('<img src="render (44).png">', {
      getMediaSize: (name) => (name === "render (44).png" ? { width: 29, height: 26 } : undefined),
    });
    expect(result.text).toBe("![[render (44).png|29]]");
  });

  it("prefers an explicit <img width> attribute over the intrinsic size", () => {
    const result = AnkiSanitizer.sanitizeField('<img src="a.png" width="120">', {
      getMediaSize: () => ({ width: 600, height: 400 }),
    });
    expect(result.text).toBe("![[a.png|120]]");
  });

  it("emits a bare embed when no size information is available", () => {
    expect(AnkiSanitizer.sanitizeField('<img src="a.png">').text).toBe("![[a.png]]");
  });

  it("strips [latex] wrappers and keeps the inner text + $…$", () => {
    const result = AnkiSanitizer.sanitizeField("[latex]Bestimmen Sie $A=(a_{ij})$.[/latex]");
    expect(result.text).toBe("Bestimmen Sie $A=(a_{ij})$.");
  });

  it("converts Anki [$] and [$$] math delimiters", () => {
    expect(AnkiSanitizer.sanitizeField("[$]a+b[/$]").text).toBe("$a+b$");
    expect(AnkiSanitizer.sanitizeField("[$$]\\sum_i x_i[/$$]").text).toBe("$$\\sum_i x_i$$");
  });

  it("converts [latex] accents and enumerate end-to-end", () => {
    const result = AnkiSanitizer.sanitizeField(
      '[latex]\\begin{enumerate}\\item Eintr\\"age unterhalb \\item \\textbf{Z}eilen\\end{enumerate}[/latex]'
    );
    expect(result.text).toContain("1. Einträge unterhalb");
    expect(result.text).toContain("2. **Z**eilen");
  });

  it("converts cloze deletions to ==highlight==", () => {
    const result = AnkiSanitizer.sanitizeField("Du trinkst {{c1::jeden Tag}} Bier.");
    expect(result.text).toBe("Du trinkst ==jeden Tag== Bier.");
  });

  it("relocates a cloze hint after the highlight", () => {
    const result = AnkiSanitizer.sanitizeField("Ich {{c1::gehe::verb}} nach Hause.");
    expect(result.text).toBe("Ich ==gehe== (hint: verb) nach Hause.");
  });

  it("splits a multi-line cloze answer into one highlight per line", () => {
    expect(AnkiSanitizer.sanitizeField("{{c1::A<br>B<br>C}}").text).toBe("==A==\n==B==\n==C==");
    expect(AnkiSanitizer.sanitizeField("{{c1::A\nB}}").text).toBe("==A==\n==B==");
    // Single-line answers are unchanged.
    expect(AnkiSanitizer.sanitizeField("{{c1::x}}").text).toBe("==x==");
  });

  it("strips whitespace inside cloze markers introduced by &nbsp;", () => {
    // &nbsp; decodes to a space after the cloze's own trim → must not touch the ==.
    const result = AnkiSanitizer.sanitizeField("Soit&nbsp;{{c1::&nbsp;[$]f(x)[/$]}}, ok");
    expect(result.text).toBe("Soit ==$f(x)$==, ok"); // no space inside the markers
  });

  it("keeps a single space between two adjacent clozes (both stay valid)", () => {
    const result = AnkiSanitizer.sanitizeField("{{c1::note}}&nbsp;{{c2:: [$]y[/$]}}");
    expect(result.text).toBe("==note== ==$y$==");
  });

  it("collapses a block-wrapped cloze to a single-line ==…==", () => {
    // A cloze wrapping <div>/<br> block content must not put == on separate lines
    // (the single-line cloze regex can't match a multi-line ==…==).
    const result = AnkiSanitizer.sanitizeField("Si <div>{{c1::<div><br /></div><div>[$]\\forall x[/$]</div>}}</div>");
    expect(result.text).toContain("==$\\forall x$==");
    expect(result.text).not.toMatch(/==\n/); // no marker on its own line
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
