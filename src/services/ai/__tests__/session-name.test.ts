import { sessionName, sourceDisplayName } from "../session-name";

describe("session names", () => {
  it("names a source by its file", () => {
    expect(sourceDisplayName("Lectures/Stats 1.pdf")).toBe("Stats 1");
    expect(sourceDisplayName("Notes/Median.md")).toBe("Median");
    expect(sourceDisplayName("  ")).toBeNull();
  });

  it("falls back to what was first asked, cut short", () => {
    const turns = [
      { role: "assistant" as const, text: "Hello", at: "" },
      { role: "user" as const, text: "x".repeat(70), at: "" },
    ];
    expect(sessionName({ sourceRef: "", turns })).toBe(`${"x".repeat(60)}…`);
    expect(sessionName({ sourceRef: "Stats.pdf", turns })).toBe("Stats");
    expect(sessionName({ sourceRef: "", turns: [] })).toBeNull();
  });
});
