import { escapeTableCell, unescapeTableCell, splitTableLine } from "../markdown-table";

describe("escapeTableCell", () => {
  it("escapes literal pipes and newlines outside math", () => {
    expect(escapeTableCell("a | b")).toBe("a \\| b");
    expect(escapeTableCell("line1\nline2")).toBe("line1<br>line2");
  });

  it("converts pipes inside math to \\vert / \\Vert (not \\|)", () => {
    expect(escapeTableCell("$|x|$")).toBe("$\\vert x\\vert $");
    expect(escapeTableCell("$|| u ||$")).toBe("$\\Vert  u \\Vert $");
  });

  it("leaves other LaTeX (\\;, commands, interval semicolons) untouched", () => {
    const s = "$\\forall k \\in [\\![ 1;n ]\\!], \\; v$";
    expect(escapeTableCell(s)).toBe(s);
  });

  it("handles math and a literal pipe in the same cell", () => {
    expect(escapeTableCell("$|x|$ or a | b")).toBe("$\\vert x\\vert $ or a \\| b");
  });

  it("converts an existing \\| norm inside math to \\Vert", () => {
    expect(escapeTableCell("$\\|x\\|$")).toBe("$\\Vert x\\Vert $");
  });
});

describe("splitTableLine / unescapeTableCell round-trip", () => {
  it("keeps escaped pipes as cell content, not separators", () => {
    expect(splitTableLine("| a \\| b | c |")).toEqual(["", " a \\| b ", " c ", ""]);
  });
  it("unescapes pipes and <br>", () => {
    expect(unescapeTableCell("a \\| b<br>c")).toBe("a | b\nc");
  });
});
