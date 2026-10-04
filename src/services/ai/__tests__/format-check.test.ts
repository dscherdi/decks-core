import { checkCardFormat, repairCardFormat, scanMath, type FormatIssueKind } from "../format-check";

const kinds = (back: string, front = "Q"): FormatIssueKind[] =>
  checkCardFormat({ front, back }).map((i) => i.kind);
const repaired = (back: string): string => repairCardFormat({ front: "Q", back }).back;

describe("reading math as the renderer does", () => {
  it("finds inline and display math, and leaves prices and escaped dollars alone", () => {
    const text = "Mean $\\mu$ costs $5 and $10, \\$3 here, and $$\\sum x$$ there.";
    expect(scanMath(text).map((s) => [s.latex, s.display])).toEqual([
      ["\\mu", false],
      ["\\sum x", true],
    ]);
  });

  it("does not read dollars inside code as math", () => {
    expect(scanMath("Use `$x$` or\n```\n$y$\n```\nthen $z$")).toHaveLength(1);
  });
});

describe("checking a card's formatting", () => {
  it("passes clean cards, prices and code", () => {
    expect(kinds("The variance is $\\sigma^2 = E[(X-\\mu)^2]$.")).toEqual([]);
    expect(kinds("It costs $5 and $10 in total.")).toEqual([]);
    expect(kinds("Run `a == b` and `$PATH`.\n\n```js\nconst s = `**`;\n```")).toEqual([]);
    expect(kinds("Is a == b in prose? **Yes**, ==this== is marked.")).toEqual([]);
  });

  it("flags math that would show as text", () => {
    expect(kinds("The mean is \\(\\mu\\).")).toContain("paren_math");
    expect(kinds("Display \\[x^2\\]")).toContain("paren_math");
    expect(kinds("The mean is $ \\mu $.")).toContain("math_spacing");
    expect(kinds("The mean is $\\mu and that is all.")).toContain("unclosed_math");
    expect(kinds("Sum $$\\sum x")).toContain("unclosed_math");
    expect(kinds("Bad $\\frac{1}{2$ here")).toContain("invalid_math");
  });

  it("asks an injected validator about each formula", () => {
    const issues = checkCardFormat({ front: "Q", back: "See $\\badmacro$." }, (latex) =>
      latex.includes("badmacro") ? "Undefined control sequence" : null,
    );
    expect(issues).toEqual([{ kind: "invalid_math", field: "back", detail: "Undefined control sequence" }]);
  });

  it("flags markup that does not pair up", () => {
    expect(kinds("This is **bold.")).toContain("unbalanced_bold");
    expect(kinds("```\ncode with no end")).toContain("unbalanced_code");
    expect(kinds("Call `run( now")).toContain("unbalanced_code");
    expect(kinds("A ==highlight that never ends")).toContain("unbalanced_highlight");
  });

  it("flags the reply format leaking into a field", () => {
    expect(kinds("Answer\nFRONT: next question")).toContain("stray_label");
    expect(kinds("Answer\n===END===")).toContain("stray_delimiter");
    expect(kinds("```markdown\nThe answer\n```")).toContain("fenced_field");
    expect(kinds("```python\nprint(1)\n```")).toEqual([]);
    expect(kinds("| a | $$x^2$$ |\n|---|---|")).toContain("table_display_math");
  });

  it("says which field a fault is in", () => {
    expect(checkCardFormat({ front: "What is \\(x\\)?", back: "ok", notes: "**n" })).toEqual([
      { kind: "paren_math", field: "front" },
      { kind: "unbalanced_bold", field: "notes" },
    ]);
  });
});

describe("repairing a card's formatting", () => {
  it("converts parenthesis math and trims spaces inside dollars", () => {
    expect(repaired("Mean \\( \\mu \\) and \\[ \\sum x \\]")).toBe("Mean $\\mu$ and $$\\sum x$$");
    expect(repaired("Mean $ \\mu $ and $x $")).toBe("Mean $\\mu$ and $x$");
  });

  it("never touches prices, code, or the space between two formulas", () => {
    for (const text of [
      "It costs $ 5 and $ 10.",
      "Both $a$ = $b$ hold.",
      "Run `\\(x\\)` and `$ x $`.",
      "A lone $\\mu with no end stays as written.",
    ]) {
      expect(repaired(text)).toBe(text);
    }
  });

  it("strips the reply format from a field", () => {
    expect(repaired("```markdown\nThe answer\n```")).toBe("The answer");
    expect(repaired("BACK: The answer")).toBe("The answer");
    expect(repaired("**BACK:** The answer")).toBe("The answer");
    expect(repaired("The answer\n===END===")).toBe("The answer");
    expect(repaired("The answer **")).toBe("The answer");
    expect(repaired("** The answer")).toBe("The answer");
  });

  it("leaves a fenced code answer as code", () => {
    const code = "```python\nprint(1)\n```";
    expect(repaired(code)).toBe(code);
  });

  it("is idempotent, and returns the same card when nothing needed fixing", () => {
    const card = { front: "Q", back: "Mean \\( \\mu \\) and $ x $ **", notes: "" };
    const once = repairCardFormat(card);
    expect(repairCardFormat(once)).toBe(once);
    const clean = { front: "Q", back: "Fine $x$." };
    expect(repairCardFormat(clean)).toBe(clean);
    expect(checkCardFormat(once)).toEqual([]);
  });
});
