import { convertAnkiLatexMarkup } from "../AnkiLatex";

describe("convertAnkiLatexMarkup", () => {
  it("converts [$] and [$$] math delimiters", () => {
    expect(convertAnkiLatexMarkup("[$]a+b[/$]")).toBe("$a+b$");
    expect(convertAnkiLatexMarkup("[$$]\\sum_i x_i[/$$]")).toBe("$$\\sum_i x_i$$");
  });

  it("strips the [latex] wrapper, keeping inner text + $…$", () => {
    expect(convertAnkiLatexMarkup("[latex]Bestimmen Sie $A=(a_{ij})$.[/latex]")).toBe(
      "Bestimmen Sie $A=(a_{ij})$."
    );
  });

  it("converts German accents (umlauts, ß) outside math", () => {
    expect(convertAnkiLatexMarkup('[latex]Eintr\\"age oberhalb[/latex]')).toBe("Einträge oberhalb");
    expect(convertAnkiLatexMarkup("[latex]gro\\ss[/latex]")).toBe("groß");
    expect(convertAnkiLatexMarkup('[latex]\\"Uber[/latex]')).toBe("Über");
  });

  it("converts \\textbf/\\textit", () => {
    expect(convertAnkiLatexMarkup("[latex]\\textbf{Z}eilen \\textit{x}[/latex]")).toBe("**Z**eilen *x*");
  });

  it("converts \\begin{enumerate} to a numbered list", () => {
    const out = convertAnkiLatexMarkup(
      "[latex]\\begin{enumerate}\\item Diagonalelemente? \\item Eintr\\\"age?\\end{enumerate}[/latex]"
    );
    expect(out).toContain("1. Diagonalelemente?");
    expect(out).toContain("2. Einträge?");
  });

  it("converts \\begin{tabular} to a markdown table, keeping $…$ cells", () => {
    const out = convertAnkiLatexMarkup(
      "[latex]\\begin{center}\\begin{tabular}{c|c|c} $\\mathcal{A}$ & $\\mathcal{B}$ & $\\mathcal{A}\\land\\mathcal{B}$\\\\ \\hline $w$ & $w$ & $w$ \\\\ $w$ & $f$ & $f$ \\end{tabular}\\end{center}[/latex]"
    );
    expect(out).toContain("| $\\mathcal{A}$ | $\\mathcal{B}$ | $\\mathcal{A}\\land\\mathcal{B}$ |");
    expect(out).toContain("| --- | --- | --- |");
    expect(out).toContain("| $w$ | $w$ | $w$ |");
    expect(out).toContain("| $w$ | $f$ | $f$ |");
    expect(out).not.toContain("\\begin"); // tabular/center consumed
    expect(out).not.toContain("\\hline");
  });

  it("preserves math verbatim (does not touch \\mbox / array inside $…$)", () => {
    const out = convertAnkiLatexMarkup("[latex]Sei $A \\in \\mbox{M}_{nn}(\\mathbb{K})$ gegeben.[/latex]");
    expect(out).toBe("Sei $A \\in \\mbox{M}_{nn}(\\mathbb{K})$ gegeben.");
  });

  it("converts German quotes and \\ss with the {} idiom", () => {
    expect(convertAnkiLatexMarkup("[latex]\\glqq Alle sind flei\\ss{}ig.\\grqq?[/latex]")).toBe(
      "„Alle sind fleißig.“?"
    );
  });

  it("converts special letters and punctuation symbols outside math", () => {
    // \cmd{} keeps following spaces; a bare \cmd eats one trailing space (LaTeX rule).
    expect(convertAnkiLatexMarkup("[latex]\\o{} \\ae{} \\ldots{}[/latex]")).toBe("ø æ …");
    expect(convertAnkiLatexMarkup("[latex]a \\textendash{} b[/latex]")).toBe("a – b");
  });

  it("unwraps \\textrm/\\text/\\mbox outside math but keeps them inside math", () => {
    expect(convertAnkiLatexMarkup("[latex]\\textrm{Hallo} $\\mbox{M}_{nn}$[/latex]")).toBe(
      "Hallo $\\mbox{M}_{nn}$"
    );
  });

  it("leaves text without Anki LaTeX markup untouched", () => {
    expect(convertAnkiLatexMarkup("Just **markdown** and $x^2$")).toBe("Just **markdown** and $x^2$");
  });
});
