import { prepareClozeMath } from "../clozeMath";

describe("prepareClozeMath", () => {
  it("blanks an active cloze inside inline math with valid LaTeX", () => {
    const { markdown, markActiveIndex } = prepareClozeMath(
      "$|z| = ==\\sqrt{z \\overline{z}}==$",
      0,
      "open",
      false
    );
    expect(markdown).toBe("$|z| = \\boxed{?}$");
    expect(markdown).not.toContain("==");
    expect(markActiveIndex).toBe(-1); // active cloze is in math → nothing for the <mark> pass
  });

  it("reveals an active math cloze as the underlined answer", () => {
    const { markdown } = prepareClozeMath("$|z| = ==\\sqrt{z \\overline{z}}==$", 0, "open", true);
    expect(markdown).toBe("$|z| = \\underline{\\sqrt{z \\overline{z}}}$");
  });

  it("is a no-op for content without math (mark index = active order)", () => {
    const src = "The capital is ==Paris== and ==France==.";
    const { markdown, markActiveIndex } = prepareClozeMath(src, 1, "open", false);
    expect(markdown).toBe(src);
    expect(markActiveIndex).toBe(1);
  });

  it("handles a card mixing a plain cloze and a math cloze", () => {
    const src = "Recall ==plain== then $x = ==y==$";
    // active = the plain (global 0, out of math) → left as ==plain==, mark index 0
    const a = prepareClozeMath(src, 0, "open", false);
    expect(a.markdown).toBe("Recall ==plain== then $x = y$"); // math cloze not active, open → shown
    expect(a.markActiveIndex).toBe(0);
    // active = the math one (global 1) → blanked in LaTeX, plain left for the <mark> pass
    const b = prepareClozeMath(src, 1, "open", false);
    expect(b.markdown).toBe("Recall ==plain== then $x = \\boxed{?}$");
    expect(b.markActiveIndex).toBe(-1);
  });

  it("blanks only the active cloze among several in one math span (hidden mode blanks the rest)", () => {
    const src = "$a = ==x==,\\ b = ==y==$";
    const open = prepareClozeMath(src, 0, "open", false);
    expect(open.markdown).toBe("$a = \\boxed{?},\\ b = y$"); // other shown in open mode
    const hidden = prepareClozeMath(src, 0, "hidden", false);
    // Active reads ?, other hidden clozes read ⋯ so the tested one is distinguishable.
    expect(hidden.markdown).toBe("$a = \\boxed{?},\\ b = \\boxed{\\cdots}$");
  });

  it("supports block math ($$…$$)", () => {
    const { markdown } = prepareClozeMath("$$E = ==mc^2==$$", 0, "open", false);
    expect(markdown).toBe("$$E = \\boxed{?}$$");
  });

  it("leaves a cloze that WRAPS math (`==$…$==`) untouched", () => {
    const src = "==$r(1+e\\cos(\\theta)) = p$==";
    const { markdown, markActiveIndex } = prepareClozeMath(src, 0, "hidden", false);
    expect(markdown).toBe(src); // out-of-math → handled by the <mark> post-processor
    expect(markActiveIndex).toBe(0);
  });

  it("leaves a cloze that CONTAINS math untouched", () => {
    const src = "Conique de ==foyer F, d'équation $x = \\frac{p}{e}$ et d'excentricité e.==";
    const { markdown, markActiveIndex } = prepareClozeMath(src, 0, "hidden", false);
    expect(markdown).toBe(src);
    expect(markActiveIndex).toBe(0);
  });

  it("maps the active index for two out-of-math clozes (one wraps math, one plain)", () => {
    const src = "==$r = p$==\n\nConique de ==foyer F, $x=\\frac{p}{e}$==";
    expect(prepareClozeMath(src, 0, "hidden", false)).toEqual({ markdown: src, markActiveIndex: 0 });
    expect(prepareClozeMath(src, 1, "hidden", false)).toEqual({ markdown: src, markActiveIndex: 1 });
  });
});
