import { LegacySrMigrator } from "../LegacySrMigrator";
import type { MigratedCard } from "../LegacySrMigrator";

// Comprehensive "real-world messiness" suite. Assertions reflect Decks' ACTUAL
// architecture, which differs from a generic SM-2/Anki model:
//   - reverse cards are ONE card with isReverse (the sync expands forward+reverse);
//   - cloze cards get a breadcrumb / filename front (never null);
//   - fronts are flattened breadcrumbs (ancestor headers + list items);
//   - clozes are independent ==highlights== (no per-cloze hide; a profile setting
//     governs show/hide globally).

const OPTS = { srBaseTag: "#flashcards", decksBaseTag: "#decks", noteTitle: "Note" };
const proc = (md: string): MigratedCard[] =>
  LegacySrMigrator.processFile(md, OPTS).dbRecords;

describe("Group 1 — basic inline cards", () => {
  it("1.1 standard forward card (front may end with ?)", () => {
    const [c] = proc("What is the capital of France? :: Paris");
    expect(c.isReverse).toBe(false);
    expect(c.front).toBe("What is the capital of France?");
    expect(c.back).toBe("Paris");
  });

  it("1.2 reverse `:::` is ONE card with isReverse (sync expands the twin)", () => {
    const cards = proc("Apple ::: Manzana");
    expect(cards).toHaveLength(1);
    expect(cards[0].isReverse).toBe(true);
    expect(cards[0].front).toBe("Apple");
    expect(cards[0].back).toBe("Manzana");
    // Reverse is a file-level flag: rendered into a `(reversed)` file.
    const files = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, {});
    const rev = files.find((f) => f.reverse);
    expect(rev).toBeDefined();
    expect(rev!.content).toContain("reverse: true");
  });
});

describe("Group 2 — multi-line cards", () => {
  it("2.1 standard multi-line block joins back lines", () => {
    const [c] = proc(
      "Explain the function of the Mitochondria.\n?\nIt is the powerhouse of the cell.\nIt generates most of the cell's supply of ATP."
    );
    expect(c.multiline).toBe(true);
    expect(c.front).toBe("Explain the function of the Mitochondria.");
    expect(c.back).toBe(
      "It is the powerhouse of the cell.\nIt generates most of the cell's supply of ATP."
    );
  });

  it("2.2 reverse multi-line `??`", () => {
    const [c] = proc("List the first three elements.\n??\n1. Hydrogen\n2. Helium\n3. Lithium");
    expect(c.isReverse).toBe(true);
    expect(c.back).toContain("1. Hydrogen");
  });
});

describe("Group 3 — clozes", () => {
  it("3.1 orphaned cloze → front falls back to the note title", () => {
    const [c] = proc("The primary component of plant cell walls is ==cellulose==.");
    expect(c.clozes).toBeDefined();
    expect(c.front).toBe("Note");
    expect(c.clozes!.map((x) => x.clozeText)).toEqual(["cellulose"]);
  });

  it("3.2 heading breadcrumb cloze (bold is NOT a cloze — use ==)", () => {
    const [c] = proc("### Botany\nThe primary component is ==cellulose==.");
    expect(c.front).toBe("Botany");
    expect(c.clozes!.map((x) => x.clozeText)).toEqual(["cellulose"]);
  });

  it("3.3 list-item cloze with `{{}}`", () => {
    const [c] = proc("- The atomic number is the number of {{protons}} in a nucleus.");
    expect(c.clozes!.map((x) => x.clozeText)).toEqual(["protons"]);
  });
});

describe("Group 4 — advanced clozes", () => {
  it("4.1 hint `{{x::hint}}` relocates the hint, clozeText is the answer", () => {
    const [c] = proc("The capital of Japan is {{Tokyo::city}}.");
    expect(c.clozes![0].clozeText).toBe("Tokyo");
    expect(c.back).toContain("==Tokyo== (hint: city)");
  });

  it("4.2 sequenced `==1::a== ==2::b==` → two ordered clozes, numbers dropped", () => {
    const [c] = proc("Humans inhale ==1::oxygen== and exhale ==2::carbon dioxide==.");
    expect(c.clozes!.map((x) => [x.clozeText, x.clozeOrder])).toEqual([
      ["oxygen", 0],
      ["carbon dioxide", 1],
    ]);
  });

  it("4.3 hide flag `{{h::mass}}` → answer is `mass` (no per-cloze hide)", () => {
    const [c] = proc("Force is {{h::mass}} times {{h::acceleration}}.");
    expect(c.clozes!.map((x) => x.clozeText)).toEqual(["mass", "acceleration"]);
  });
});

describe("Group 5 — dirty markdown", () => {
  it("5.1 existing SR comment is stripped and its state extracted", () => {
    const [c] = proc("What is 2+2? :: 4 <!--SR:!2023-10-12,4,270-->");
    expect(c.back).toBe("4");
    expect(c.fsrsData).toBeDefined();
    expect(c.fsrsData!.stability).toBe(4);
  });

  it("5.2 a fenced code block produces ZERO cards", () => {
    const md = [
      "Here is a coding example:",
      "",
      "```javascript",
      "const x = a ? b : c;",
      "// Do not parse this :: as a card",
      "```",
    ].join("\n");
    expect(proc(md)).toHaveLength(0);
  });

  it("5.3 LaTeX before `::` — the math stays in the front", () => {
    const [c] = proc("Calculate the area: $A = \\pi r^2$ :: The area of a circle.");
    expect(c.front).toBe("Calculate the area: $A = \\pi r^2$");
    expect(c.back).toBe("The area of a circle.");
  });

  it("5.4 a trailing block reference is stripped from a cloze", () => {
    const [c] = proc("Berlin is the capital of Germany. ==Berlin== ^d8f9a2");
    expect(c.clozes![0].clozeText).toBe("Berlin");
    expect(c.back).not.toContain("d8f9a2");
  });
});

describe("Group 6 — embeds & links", () => {
  it("6.1 image embed survives in the front", () => {
    const [c] = proc("What does this represent? ![[transformation.png]] :: A shear mapping.");
    expect(c.front).toBe("What does this represent? ![[transformation.png]]");
    expect(c.back).toBe("A shear mapping.");
  });

  it("6.2 wikilinks are not confused with clozes", () => {
    const [c] = proc("The foundation of [[Calculus]] was developed by ==Newton== and ==Leibniz==.");
    expect(c.clozes!.map((x) => x.clozeText)).toEqual(["Newton", "Leibniz"]);
    expect(c.back).toContain("[[Calculus]]");
  });
});

describe("Group 7 — math & structure", () => {
  it("7.1 a cloze inside `$$` display math is recognized", () => {
    const [c] = proc("Calculate the limit:\n$$ \\lim_{x \\to 0} \\frac{\\sin x}{x} = ==1== $$");
    expect(c.clozes!.map((x) => x.clozeText)).toEqual(["1"]);
    expect(c.back).toContain("$$");
  });

  it("7.3 nested-list answer keeps its (relative) indentation", () => {
    const [c] = proc("Properties?\n??\n- Reflexive\n\t- $a \\sim a$\n- Symmetric");
    // The nested bullet stays indented under its parent (tabs may be normalized
    // to spaces, but the hierarchy is not flattened).
    expect(c.back).toMatch(/\n\s+- \$a \\sim a\$/);
    expect(c.back).toContain("- Reflexive");
  });
});

describe("Group 8 — tags", () => {
  it("8.1 inline tags are moved to the card's tags, base tag dropped", () => {
    const [c] = proc("Define a continuous function. #analysis #flashcards :: A function.");
    expect(c.front).toBe("Define a continuous function.");
    expect(c.back).toBe("A function.");
    expect(c.tags).toContain("analysis");
    expect(c.tags).not.toContain("flashcards");
  });
});

describe("Group 9 — empty / malformed", () => {
  it("9.1 a missing back yields no card (graceful, no throw)", () => {
    expect(proc("What happens if I forget the answer? :: ")).toHaveLength(0);
  });

  it("9.2 an unclosed cloze is treated as plain text (no card, no loop)", () => {
    expect(proc("The capital of Germany is ==Berlin.")).toHaveLength(0);
  });
});

describe("Group 10 — outlines & hierarchy", () => {
  it("10.1 a deeply nested basic card strips bullets, flattens the breadcrumb", () => {
    const md = [
      "- University",
      "  - Semester 1",
      "    - Biology 101",
      "      - What is the powerhouse of the cell? :: Mitochondria",
    ].join("\n");
    const [c] = proc(md);
    expect(c.back).toBe("Mitochondria");
    expect(c.front).toContain("What is the powerhouse of the cell?");
    expect(c.front).toContain("Biology 101");
    expect(c.front).not.toContain("- ");
  });

  it("10.2 a nested cloze flattens the ancestor list path into the front", () => {
    const md = [
      "- **Continent: Europe**",
      "    - Country: Germany",
      "        - The capital is ==Berlin==.",
    ].join("\n");
    const [c] = proc(md);
    expect(c.clozes!.map((x) => x.clozeText)).toEqual(["Berlin"]);
    expect(c.front).toContain("Country: Germany");
  });

  it("10.3 a list item + indented `??` + list answer (outliner pattern)", () => {
    const md = [
      "- Name the three states of matter.",
      "  ??",
      "  - Solid",
      "  - Liquid",
      "  - Gas",
    ].join("\n");
    const [c] = proc(md);
    expect(c).toBeDefined();
    expect(c.isReverse).toBe(true);
    expect(c.front).toBe("Name the three states of matter.");
    expect(c.back).toContain("- Solid");
    expect(c.back).toContain("- Gas");
  });

  it("10.4 a lone top H1 is dropped from the breadcrumb", () => {
    const md = [
      "# Medical School",
      "## Anatomy",
      "### Cardiovascular System",
      "What is the largest artery? :: The aorta.",
    ].join("\n");
    const [c] = proc(md);
    expect(c.back).toBe("The aorta.");
    expect(c.front).toContain("Cardiovascular System");
    expect(c.front).not.toContain("Medical School");
  });

  it("10.5 sibling cards at the same indent stay distinct", () => {
    const md = ["- Vocabulary:", "- El perro :: The dog", "- El gato :: The cat"].join("\n");
    const cards = proc(md);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.back)).toEqual(["The dog", "The cat"]);
    expect(cards[0].front).toContain("El perro");
    expect(cards[1].front).toContain("El gato");
  });
});

describe("Group 11 — scheduling state", () => {
  it("11.1 SM-2 due/interval/ease → FsrsState", () => {
    const [c] = proc("Capital of Italy? :: Rome <!--SR:!2023-11-05,5,250-->");
    const s = c.fsrsData!;
    expect(s.due).toBe(Date.parse("2023-11-05"));
    expect(s.stability).toBe(5);
    expect(s.intervalDays).toBe(5);
    expect(s.difficulty).toBe(5); // ease 250 → middle bucket
  });

  it("11.3 multi-cloze stacked `!`-state maps one state per highlight", () => {
    const [c] = proc(
      "Einstein was born in ==Ulm== in ==1879==. <!--SR:!2023-11-01,3,250!2023-11-05,7,270-->"
    );
    expect(c.clozes!.map((x) => x.fsrsData?.stability)).toEqual([3, 7]);
  });

  it("11.4 a malformed state (missing ease) does not produce NaN", () => {
    const [c] = proc("What is 2+2? :: 4 <!--SR:!2023-10-12,4-->");
    // Either parsed with a finite difficulty, or treated as no-state — never NaN.
    if (c.fsrsData) {
      expect(Number.isFinite(c.fsrsData.difficulty)).toBe(true);
      expect(Number.isFinite(c.fsrsData.stability)).toBe(true);
    }
    expect(c.back).toBe("4");
  });

  it("11.5 note-level sr-* YAML is read by parseFileLevelState", () => {
    const md = ["---", "sr-due: 2023-12-01", "sr-interval: 14", "sr-ease: 260", "---", "# Note", "Body."].join("\n");
    const state = LegacySrMigrator.parseFileLevelState(md);
    expect(state).not.toBeNull();
    expect(state!.stability).toBe(14);
    expect(state!.intervalDays).toBe(14);
  });
});

describe("Group 12 — YAML frontmatter & note-level state", () => {
  it("12.2 a note with note-level state AND an inline card yields both signals", () => {
    const md = [
      "---",
      "sr-due: 2023-10-05",
      "sr-interval: 8",
      "sr-ease: 250",
      "---",
      "# Anatomy",
      "The heart has 4 chambers.",
      "What is the largest artery? :: Aorta",
    ].join("\n");
    // Inline card is parsed...
    const cards = proc(md);
    expect(cards).toHaveLength(1);
    expect(cards[0].back).toBe("Aorta");
    // ...and the note-level state is independently available.
    const state = LegacySrMigrator.parseFileLevelState(md);
    expect(state!.stability).toBe(8);
  });

  it("12.3 malformed frontmatter does not crash; the body still parses", () => {
    const md = [
      "---",
      "Review: easy",
      "sr-due: 2023-12-01",
      "Here is some text that should not be in frontmatter.",
      "---",
      "# Title",
      "Capital of France :: Paris",
    ].join("\n");
    expect(() => proc(md)).not.toThrow();
    const cards = proc(md);
    expect(cards.some((c) => c.back === "Paris")).toBe(true);
  });
});
