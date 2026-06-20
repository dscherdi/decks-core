import { LegacySrMigrator } from "../LegacySrMigrator";
import type { MigratedCard } from "../LegacySrMigrator";

const OPTS = { srBaseTag: "#flashcards", decksBaseTag: "#decks" };

function process(content: string): MigratedCard[] {
  return LegacySrMigrator.processFile(content, OPTS).dbRecords;
}

describe("LegacySrMigrator.processFile", () => {
  it("parses a single-line forward card", () => {
    const cards = process("Capital of France :: Paris <!--SR:!2023-10-16,4,250-->");
    expect(cards).toHaveLength(1);
    expect(cards[0].front).toBe("Capital of France");
    expect(cards[0].back).toBe("Paris");
    expect(cards[0].isReverse).toBe(false);
    expect(cards[0].fsrsData).toBeDefined();
    expect(cards[0].fsrsDataReverse).toBeUndefined();
  });

  it("parses a single-line reversed card via :::", () => {
    const cards = process("Cat ::: Gato");
    expect(cards).toHaveLength(1);
    expect(cards[0].isReverse).toBe(true);
    expect(cards[0].front).toBe("Cat");
    expect(cards[0].back).toBe("Gato");
  });

  it("does not mis-classify ::: as forward (precedence)", () => {
    const cards = process("A ::: B");
    expect(cards[0].isReverse).toBe(true);
    expect(cards[0].back).toBe("B");
  });

  it("parses a multi-line forward card", () => {
    const cards = process("Front line\n?\nBack line");
    expect(cards).toHaveLength(1);
    expect(cards[0].isReverse).toBe(false);
    expect(cards[0].front).toBe("Front line");
    expect(cards[0].back).toBe("Back line");
  });

  it("parses a multi-line reversed card via ??", () => {
    const cards = process("Front\n??\nBack");
    expect(cards).toHaveLength(1);
    expect(cards[0].isReverse).toBe(true);
  });

  it("captures a bulleted-list answer as the multi-line back", () => {
    const content = [
      "Why are comments considered a code smell?",
      "?",
      "- They tend to compensate for bad code",
      "- They deteriorate over time and can lie",
      "- Most of the time are useless",
      "",
      "These are the comments that should be allowed:",
      "?",
      "- Legal / Copyright comments",
      "- Hard to understand lines like regex query",
    ].join("\n");
    const cards = process(content);
    expect(cards).toHaveLength(2);
    expect(cards[0].front).toBe("Why are comments considered a code smell?");
    expect(cards[0].back).toBe(
      "- They tend to compensate for bad code\n- They deteriorate over time and can lie\n- Most of the time are useless"
    );
    expect(cards[1].front).toBe("These are the comments that should be allowed:");
    expect(cards[1].back).toContain("- Legal / Copyright comments");
  });

  it("preserves and translates inline tags to the target base tag", () => {
    const cards = process("Photosynthesis :: Plants make energy #flashcards/biology");
    expect(cards[0].tags).toEqual(["decks/biology"]);
    expect(cards[0].back).toBe("Plants make energy");
  });

  it("drops a bare base tag from the card (it becomes the file-level deck tag)", () => {
    const cards = process("Q :: A #flashcards");
    expect(cards[0].tags).toEqual([]);
  });

  describe("metadata translation", () => {
    it("maps SM-2 ease to difficulty buckets", () => {
      const high = process("a :: b <!--SR:!2023-10-16,4,260-->")[0].fsrsData!;
      const mid = process("a :: b <!--SR:!2023-10-16,4,230-->")[0].fsrsData!;
      const low = process("a :: b <!--SR:!2023-10-16,4,200-->")[0].fsrsData!;
      expect(high.difficulty).toBe(3);
      expect(mid.difficulty).toBe(5);
      expect(low.difficulty).toBe(8);
    });

    it("uses interval as stability and clamps to >= 1", () => {
      const s = process("a :: b <!--SR:!2023-10-16,0,250-->")[0].fsrsData!;
      expect(s.stability).toBe(1);
      expect(s.reps).toBe(1);
      expect(s.lapses).toBe(0);
    });

    it("maps extended FSRS data directly when present", () => {
      const s = process("a :: b <!--SR:!2024-06-18,12,250!4.5,12.2,3,1-->")[0].fsrsData!;
      expect(s.difficulty).toBeCloseTo(4.5);
      expect(s.stability).toBeCloseTo(12.2);
      expect(s.reps).toBe(3);
      expect(s.lapses).toBe(1);
    });

    it("carries the SR interval into intervalDays (SM-2 and FSRS)", () => {
      const sm2 = process("a :: b <!--SR:!2024-06-18,12,250-->")[0].fsrsData!;
      expect(sm2.intervalDays).toBe(12);
      const fsrs = process("a :: b <!--SR:!2024-06-18,12,250!4.5,12.2,3,1-->")[0].fsrsData!;
      expect(fsrs.intervalDays).toBe(12);
    });

    it("parses two independent states for a reversed card (SM-2)", () => {
      const card = process("Cat ::: Gato <!--SR:!2023-10-16,4,260!2023-10-18,6,200-->")[0];
      expect(card.fsrsData!.difficulty).toBe(3); // ease 260 -> 3
      expect(card.fsrsDataReverse!.difficulty).toBe(8); // ease 200 -> 8
      expect(card.fsrsData!.stability).toBe(4);
      expect(card.fsrsDataReverse!.stability).toBe(6);
    });

    it("parses two independent states for a reversed card (FSRS)", () => {
      const card = process(
        "Cat ::: Gato <!--SR:!2023-10-16,4,250!4.5,12.2,0,1!2023-10-18,6,270!4.2,14.1,2,0-->"
      )[0];
      expect(card.fsrsData!.stability).toBeCloseTo(12.2);
      expect(card.fsrsData!.lapses).toBe(1);
      expect(card.fsrsDataReverse!.stability).toBeCloseTo(14.1);
      expect(card.fsrsDataReverse!.reps).toBe(2);
    });

    it("leaves the reverse twin new when only one state is present", () => {
      const card = process("Cat ::: Gato <!--SR:!2023-10-16,4,250-->")[0];
      expect(card.fsrsData).toBeDefined();
      expect(card.fsrsDataReverse).toBeUndefined();
    });

    it("treats a card with no SR comment as new", () => {
      const card = process("Cat :: Gato")[0];
      expect(card.fsrsData).toBeUndefined();
    });
  });

  describe("callouts and metadata stripping", () => {
    it("reads metadata from a sr callout block following the card", () => {
      const content = ["Cat :: Gato", "> [!sr|card-metadata]", "> <!--SR:!2023-10-16,4,250-->"].join(
        "\n"
      );
      const cards = process(content);
      expect(cards).toHaveLength(1);
      expect(cards[0].fsrsData).toBeDefined();
    });

    it("cleanContent strips comments and callouts and collapses blank lines", () => {
      const content = [
        "Cat :: Gato <!--SR:!2023-10-16,4,250-->",
        "",
        "> [!sr|card-metadata]",
        "> <!--SR:!2023-10-16,4,250-->",
        "",
        "",
        "",
        "Dog :: Perro",
      ].join("\n");
      const { cleanContent } = LegacySrMigrator.processFile(content, OPTS);
      expect(cleanContent).not.toContain("<!--SR:");
      expect(cleanContent).not.toContain("[!sr");
      expect(cleanContent).not.toMatch(/\n{3,}/);
    });

    it("does not create cards from orphaned metadata only", () => {
      const cards = process("> [!sr|card-metadata]\n> <!--SR:!2023-10-16,4,250-->");
      expect(cards).toHaveLength(0);
    });
  });
});

describe("breadcrumb flattening", () => {
  it("flattens ancestor headers and nested list items into the front", () => {
    const content = [
      "# Biology",
      "## Cell Anatomy",
      "* Mitochondria",
      "  * Organelles",
      "    * Energy Production",
      "      * Function :: Powerhouse",
    ].join("\n");
    const cards = process(content);
    expect(cards).toHaveLength(1);
    // Lone top-title H1 ("Biology") is dropped; the rest forms the path.
    expect(cards[0].front).toBe(
      "Cell Anatomy > Mitochondria > Organelles > Energy Production > Function"
    );
    expect(cards[0].back).toBe("Powerhouse");
  });

  it("keeps multiple H1s (only a lone title H1 is skipped)", () => {
    const content = ["# Section A", "Cat :: Gato", "# Section B", "Dog :: Perro"].join("\n");
    const cards = process(content);
    expect(cards.map((c) => c.front)).toEqual(["Section A > Cat", "Section B > Dog"]);
  });

  it("strips list/header markers from the front", () => {
    const cards = process("## Topic\n* Term :: Definition");
    expect(cards[0].front).toBe("Topic > Term");
    expect(cards[0].front).not.toContain("*");
    expect(cards[0].front).not.toContain("#");
  });

  it("does not prefix flat cards (no headers/lists)", () => {
    expect(process("Cat :: Gato")[0].front).toBe("Cat");
  });

  it("keeps card tags on the heading, not in the breadcrumb path", () => {
    const cards = process("## Animals\nCat :: Gato #flashcards/pets");
    expect(cards[0].front).toBe("Animals > Cat");
    expect(cards[0].tags).toEqual(["decks/pets"]);
  });

  it("resets list context after a blank line", () => {
    const content = ["* Ancestor", "  * Child :: A", "", "Standalone :: B"].join("\n");
    const cards = process(content);
    expect(cards[0].front).toBe("Ancestor > Child");
    expect(cards[1].front).toBe("Standalone");
  });
});

describe("suspended (skip) cards", () => {
  it("suspends a card with the #sr-skip tag and strips the marker", () => {
    const card = process("Cat :: Gato #sr-skip")[0];
    expect(card.suspended).toBe(true);
    expect(card.tags).not.toContain("sr-skip");
    expect(card.front).toBe("Cat");
  });

  it("suspends a card wrapped in an HTML skip comment and strips it", () => {
    const card = process("Cat :: Gato <!--sr-skip-->")[0];
    expect(card.suspended).toBe(true);
    expect(card.back).not.toContain("sr-skip");
    expect(card.back).toBe("Gato");
  });

  it("suspends a card wrapped in an Obsidian skip comment", () => {
    const card = process("Cat :: Gato %%sr-skip%%")[0];
    expect(card.suspended).toBe(true);
    expect(card.back).not.toContain("sr-skip");
  });

  it("leaves normal cards unsuspended", () => {
    expect(process("Cat :: Gato")[0].suspended).toBe(false);
  });
});

describe("custom delimiters", () => {
  it("parses a custom inline separator and derives its reverse", () => {
    const opts = { srBaseTag: "#flashcards", decksBaseTag: "#decks", inlineSep: "==" };
    const fwd = LegacySrMigrator.processFile("Cat == Gato", opts).dbRecords[0];
    expect(fwd.front).toBe("Cat");
    expect(fwd.back).toBe("Gato");
    expect(fwd.isReverse).toBe(false);
    const rev = LegacySrMigrator.processFile("Cat === Gato", opts).dbRecords[0];
    expect(rev.isReverse).toBe(true);
  });

  it("handles a regex-metachar separator safely", () => {
    const opts = { srBaseTag: "#flashcards", decksBaseTag: "#decks", inlineSep: "|=|" };
    const card = LegacySrMigrator.processFile("A |=| B", opts).dbRecords[0];
    expect(card.front).toBe("A");
    expect(card.back).toBe("B");
  });

  it("parses a custom multi-line separator", () => {
    const opts = { srBaseTag: "#flashcards", decksBaseTag: "#decks", multiSep: "---?" };
    const card = LegacySrMigrator.processFile("Front\n---?\nBack", opts).dbRecords[0];
    expect(card.multiline).toBe(true);
    expect(card.front).toBe("Front");
    expect(card.back).toBe("Back");
  });
});

describe("pipe guardrail (smart routing)", () => {
  it("routes a single-line card containing | to a header, not a table", () => {
    const cards = process("Absolute value :: $|x| = \\max(x,-x)$");
    const [main] = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, { format: "smart" });
    expect(main.content).toContain("## Absolute value");
    expect(main.content).not.toContain("| Front | Back | Notes |");
  });

  it("still tables a pipe-free single-line card in smart mode", () => {
    const cards = process("Cat :: Gato");
    const [main] = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, { format: "smart" });
    expect(main.content).toContain("| Front | Back | Notes |");
  });
});

describe("cloze migration", () => {
  const clozeOpts = { srBaseTag: "#flashcards", decksBaseTag: "#decks", noteTitle: "MyNote" };
  const cloze = (content: string) =>
    LegacySrMigrator.processFile(content, clozeOpts).dbRecords;

  it("converts {{x}}, {{c1::x}}, and ==x== to highlights with ordered clozes", () => {
    const card = cloze("The capital of {{c1::France}} is ==Paris== and {{the Louvre}}.")[0];
    expect(card.clozes).toBeDefined();
    expect(card.back).toContain("==France==");
    expect(card.back).toContain("==Paris==");
    expect(card.back).toContain("==the Louvre==");
    expect(card.clozes!.map((c) => [c.clozeText, c.clozeOrder])).toEqual([
      ["France", 0],
      ["Paris", 1],
      ["the Louvre", 2],
    ]);
  });

  it("relocates an Anki hint outside the highlight with a translated label", () => {
    const card = cloze("The capital is {{c1::Paris::capital city}}.")[0];
    expect(card.back).toContain("==Paris== (hint: capital city)");
    expect(card.clozes![0].clozeText).toBe("Paris"); // hint not part of clozeText
  });

  it("relocates a footnote hint", () => {
    const card = cloze("The capital is ==Paris==^[capital city].")[0];
    expect(card.back).toContain("==Paris== (hint: capital city)");
    expect(card.clozes![0].clozeText).toBe("Paris");
  });

  it("parses the SR `;;` separator inside == highlights, dropping the number", () => {
    const card = cloze("The capital is ==1;;Paris;;capital city==.")[0];
    expect(card.back).toContain("==Paris== (hint: capital city)");
    expect(card.clozes![0].clozeText).toBe("Paris");
  });

  it("accepts `::` inside == highlights too", () => {
    const card = cloze("The capital is ==Paris::capital city==.")[0];
    expect(card.back).toContain("==Paris== (hint: capital city)");
    expect(card.clozes![0].clozeText).toBe("Paris");
  });

  it("parses the `;;` separator inside curly clozes", () => {
    const card = cloze("The capital is {{Paris;;capital city}}.")[0];
    expect(card.back).toContain("==Paris== (hint: capital city)");
    expect(card.clozes![0].clozeText).toBe("Paris");
  });

  it("respects a custom clozeSep option", () => {
    const card = LegacySrMigrator.processFile("X is ==Paris@@capital==.", {
      ...clozeOpts,
      clozeSep: "@@",
    }).dbRecords[0];
    expect(card.back).toContain("==Paris== (hint: capital)");
    expect(card.clozes![0].clozeText).toBe("Paris");
  });

  it("maps the packed states to highlights in document order", () => {
    const card = cloze(
      "{{c1::A}} then ==B== then {{C}}.\n<!--SR:!2024-06-18,4,250!2024-06-19,9,250!2024-06-20,16,250-->"
    )[0];
    expect(card.clozes!.map((c) => c.fsrsData?.stability)).toEqual([4, 9, 16]);
  });

  it("uses breadcrumb as front, else the note title", () => {
    expect(cloze("The capital is ==Paris==.")[0].front).toBe("MyNote");
    expect(cloze("## Geography\nThe capital is ==Paris==.")[0].front).toBe("Geography");
  });

  it("migrates a list-item cloze (front = breadcrumb header)", () => {
    const cards = cloze("### Photosynthesis\n- Plants convert ==sunlight== into energy.");
    expect(cards).toHaveLength(1);
    expect(cards[0].front).toBe("Photosynthesis");
    expect(cards[0].clozes!.map((c) => c.clozeText)).toEqual(["sunlight"]);
  });

  it("binds a loose numbered list under one bullet into a single 4-cloze card", () => {
    const content = [
      "- **3 rules of TDD**",
      "\t1. You are not allowed to write any ==production code== unless it is to make a failing unit test pass.",
      "",
      "\t2. You are not allowed to write any more of a ==unit test== than is sufficient to fail.",
      "",
      "\t3. You are not allowed to write any more ==production code== than is sufficient to pass.",
      "",
      "\t4. Repeat the ==cycle==.",
      "<!--SR:!2022-11-26,3,250!2022-11-26,3,250!2022-11-26,3,250!2022-11-27,4,270-->",
    ].join("\n");
    const cards = cloze(content);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.clozes).toHaveLength(4);
    expect(card.clozes!.map((c) => c.clozeText)).toEqual([
      "production code",
      "unit test",
      "production code",
      "cycle",
    ]);
    // 4 SR states bind 1:1 to the 4 highlights in document order.
    expect(card.clozes!.map((c) => c.fsrsData?.stability)).toEqual([3, 3, 3, 4]);
    expect(card.front).toContain("3 rules of TDD");
    expect(card.back).toContain("==production code==");
    expect(card.back).toContain("==cycle==");
  });

  it("merges a blank-separated multi-paragraph cloze block bound by one comment", () => {
    const content = [
      "First paragraph mentions ==alpha==.",
      "",
      "Second paragraph mentions ==beta==.",
      "<!--SR:!2022-11-26,3,250!2022-11-27,4,270-->",
    ].join("\n");
    const cards = cloze(content);
    expect(cards).toHaveLength(1);
    expect(cards[0].clozes!.map((c) => c.clozeText)).toEqual(["alpha", "beta"]);
    expect(cards[0].clozes!.map((c) => c.fsrsData?.stability)).toEqual([3, 4]);
  });

  it("keeps separate cloze bullets with their own inline comments distinct", () => {
    const content = [
      "- First ==alpha== fact. <!--SR:!2022-11-26,3,250-->",
      "- Second ==beta== fact. <!--SR:!2022-11-27,7,270-->",
    ].join("\n");
    const cards = cloze(content);
    expect(cards).toHaveLength(2);
    expect(cards[0].clozes!.map((c) => c.clozeText)).toEqual(["alpha"]);
    expect(cards[0].clozes![0].fsrsData?.stability).toBe(3);
    expect(cards[1].clozes!.map((c) => c.clozeText)).toEqual(["beta"]);
    expect(cards[1].clozes![0].fsrsData?.stability).toBe(7);
  });

  it("does not mis-parse {{c1::x}} as a :: Q/A card", () => {
    const card = cloze("Term {{c1::France}} fact.")[0];
    expect(card.clozes).toBeDefined();
    expect(card.isReverse).toBe(false);
  });

  it("suspends a cloze block carrying #sr-skip", () => {
    const card = cloze("The capital is ==Paris==. #sr-skip")[0];
    expect(card.suspended).toBe(true);
    expect(card.back).not.toContain("sr-skip");
  });

  it("always renders cloze blocks as headers, never tables", () => {
    const cards = cloze("The capital is ==Paris==.");
    const [main] = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, { format: "tables" });
    expect(main.content).toContain("## MyNote");
    expect(main.content).toContain("==Paris==");
    expect(main.content).not.toContain("| Front | Back | Notes |");
  });
});

describe("single deck tag derivation", () => {
  it("picks the deepest SR base subtag, translated to the decks base", () => {
    const tag = LegacySrMigrator.deriveDeckTag(
      ["development/clean-code", "conspect", "flashcards/cleancode/tdd"],
      OPTS
    );
    expect(tag).toBe("decks/cleancode/tdd");
  });

  it("prefers the most-specific flashcards subtag among several", () => {
    const tag = LegacySrMigrator.deriveDeckTag(
      ["flashcards/a", "flashcards/b/c"],
      OPTS
    );
    expect(tag).toBe("decks/b/c");
  });

  it("falls back to the bare decks base when only the base tag (or none) is present", () => {
    expect(LegacySrMigrator.deriveDeckTag(["flashcards"], OPTS)).toBe("decks");
    expect(LegacySrMigrator.deriveDeckTag(["unrelated"], OPTS)).toBe("decks");
    expect(LegacySrMigrator.deriveDeckTag([], OPTS)).toBe("decks");
  });

  it("tolerates a leading # on the input tags", () => {
    expect(
      LegacySrMigrator.deriveDeckTag(["#flashcards/cleancode/tdd"], OPTS)
    ).toBe("decks/cleancode/tdd");
  });

  it("renders exactly one deck tag in the output frontmatter", () => {
    const cards = process("Capital of France :: Paris");
    const [main] = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, {
      deckTag: "decks/cleancode/tdd",
    });
    expect(main.content).toContain("  - decks/cleancode/tdd");
    // The bare base tag must NOT also appear.
    expect(main.content).not.toMatch(/^ {2}- decks$/m);
    expect(main.content).not.toContain("development/clean-code");
  });

  it("derives a review deck tag preserving the subpath", () => {
    expect(
      LegacySrMigrator.deriveReviewTag(["review/spanish"], "#review", "#decks")
    ).toBe("decks/review/spanish");
    expect(
      LegacySrMigrator.deriveReviewTag(["review"], "#review", "#decks")
    ).toBe("decks/review");
    expect(LegacySrMigrator.deriveReviewTag([], "#review", "#decks")).toBe(
      "decks/review"
    );
  });
});

describe("multiline flag", () => {
  it("marks single-line cards non-multiline and ?/?? cards multiline", () => {
    expect(process("Cat :: Gato")[0].multiline).toBe(false);
    expect(process("Cat ::: Gato")[0].multiline).toBe(false);
    expect(process("Front\n?\nBack")[0].multiline).toBe(true);
    expect(process("Front\n??\nBack")[0].multiline).toBe(true);
  });
});

describe("LegacySrMigrator.renderDecksFiles — headers format", () => {
  it("renders a single main file at the requested header level", () => {
    const cards = process("Cat :: Gato #flashcards/animals");
    const files = LegacySrMigrator.renderDecksFiles(cards, "#decks", 3, { format: "headers" });
    expect(files).toHaveLength(1);
    expect(files[0].suffix).toBe("");
    expect(files[0].content).toContain("### Cat #decks/animals");
    expect(files[0].content).toContain("Gato");
    expect(files[0].content).toContain("tags:\n  - decks");
    expect(files[0].content).not.toContain("reverse: true");
  });

  it("splits reverse cards into a (reversed) file with reverse frontmatter", () => {
    const cards = process("Cat :: Gato\n\nDog ::: Perro");
    const files = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, { format: "headers" });
    expect(files).toHaveLength(2);
    const main = files.find((f) => f.suffix === "")!;
    const reversed = files.find((f) => f.suffix === " (reversed)")!;
    expect(main.content).toContain("## Cat");
    expect(reversed.content).toContain("reverse: true");
    expect(reversed.content).toContain("## Dog");
  });
});

describe("LegacySrMigrator.renderDecksFiles — smart routing", () => {
  it("routes single-line cards to a table and multi-line cards to headers, in one file", () => {
    const cards = process("Cat :: Gato\n\nLong front\n?\nLong multi-line back");
    const [main] = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, { format: "smart" });
    expect(main.content).toContain("| Front | Back | Notes |");
    expect(main.content).toContain("| Cat | Gato |");
    expect(main.content).toContain("## Long front");
    expect(main.content).toContain("Long multi-line back");
  });

  it("groups table cards by tag-set under a tagged container header", () => {
    const cards = process("Hola :: Hi #flashcards/es\n\nBonjour :: Hi #flashcards/fr");
    const [main] = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, {
      format: "smart",
      noteTitle: "Vocab",
    });
    expect(main.content).toContain("## Vocab #decks/es");
    expect(main.content).toContain("## Vocab #decks/fr");
    expect(main.content).toContain("| Hola | Hi |");
    expect(main.content).toContain("| Bonjour | Hi |");
  });
});

describe("LegacySrMigrator.renderDecksFiles — tables format", () => {
  it("places multi-line cards into table cells using <br> and escapes pipes", () => {
    const cards = process("Front\n?\nline one\nline | two");
    const [main] = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, { format: "tables" });
    expect(main.content).toContain("line one<br>line \\| two");
  });
});

describe("LegacySrMigrator delete mode", () => {
  it("emits 6-char block refs and links header cards to them", () => {
    const original = "What is 2+2? :: 4\n\nCat ::: Gato";
    const cards = process(original);
    const files = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, {
      withBlockRefs: true,
      format: "headers",
    });
    const main = files.find((f) => !f.reverse)!;
    expect(main.content).toMatch(/4 \^[a-z0-9]{6}/);

    const linked = LegacySrMigrator.buildLinkReplacedOriginal(
      original,
      cards,
      "Deck",
      "Deck (reversed)"
    );
    expect(linked).toMatch(/\[\[Deck#\^[a-z0-9]{6}\]\]/);
    expect(linked).toMatch(/\[\[Deck \(reversed\)#\^[a-z0-9]{6}\]\]/);
    expect(linked).not.toContain("2+2? ::");
  });

  it("links table cards to their clean container header (tags on a parent header)", () => {
    const original = "Hola :: Hi #flashcards/es";
    const cards = process(original);
    const files = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, {
      withBlockRefs: true,
      format: "tables",
      noteTitle: "Vocab",
    });
    const main = files[0];
    // Container header is clean (linkable); tags live on a parent header.
    expect(main.content).toContain("## Vocab\n");
    expect(main.content).toContain("# es #decks/es");
    expect(main.content).not.toContain("## Vocab #decks/es");

    const linked = LegacySrMigrator.buildLinkReplacedOriginal(original, cards, "Deck", "Deck");
    expect(linked).toContain("[[Deck#Vocab]]");
  });

  it("keeps duplicate fronts distinct via block ids", () => {
    const cards = process("Cat :: Gato\n\nCat :: Felis catus");
    const files = LegacySrMigrator.renderDecksFiles(cards, "#decks", 2, {
      withBlockRefs: true,
      format: "headers",
    });
    const ids = files[0].cards.map((c) => c.blockId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("LegacySrMigrator whole-note reviews", () => {
  const wholeNote = (content: string) =>
    LegacySrMigrator.processWholeNote(content, "My Note");

  it("reads file-level state from sr-* YAML frontmatter (SM-2)", () => {
    const content = [
      "---",
      "sr-due: 2024-06-18",
      "sr-interval: 12",
      "sr-ease: 200",
      "tags: review",
      "---",
      "",
      "## A heading in the body",
      "Some content.",
    ].join("\n");
    const card = wholeNote(content);
    expect(card.front).toBe("My Note");
    expect(card.back).toContain("## A heading in the body");
    expect(card.back).not.toContain("sr-due");
    expect(card.fsrsData!.stability).toBe(12);
    expect(card.fsrsData!.difficulty).toBe(8); // ease 200 -> 8
  });

  it("reads FSRS keys directly when present", () => {
    const content = [
      "---",
      "sr-due: 2024-06-18",
      "sr-stability: 30",
      "sr-difficulty: 4.5",
      "sr-reps: 3",
      "sr-lapses: 1",
      "---",
      "Body",
    ].join("\n");
    const s = wholeNote(content).fsrsData!;
    expect(s.stability).toBe(30);
    expect(s.difficulty).toBeCloseTo(4.5);
    expect(s.reps).toBe(3);
    expect(s.lapses).toBe(1);
  });

  it("rejects non-ISO due dates (no NaN crash)", () => {
    const content = ["---", "sr-due: 18-06-2024", "sr-interval: 4", "sr-ease: 250", "---", "Body"].join("\n");
    expect(wholeNote(content).fsrsData).toBeUndefined();
  });

  it("falls back to an EOF SR comment when no sr-* YAML", () => {
    const content = "Body of the note\n\n<!--SR:!2024-06-18,12,250-->";
    const card = wholeNote(content);
    expect(card.fsrsData!.stability).toBe(12);
    expect(card.back).not.toContain("<!--SR:");
  });

});

describe("LegacySrMigrator.renderTitleModeFile (duplicate)", () => {
  const reviewNote = [
    "---",
    "sr-due: 2024-06-18",
    "sr-interval: 5",
    "sr-ease: 250",
    "tags:",
    "  - review",
    "  - flashcards/cleancode/comments",
    "---",
    "",
    "## A section",
    "Body content.",
    "<!--SR:!2024-06-18,5,250-->",
  ].join("\n");

  it("renders a title-mode file with exactly the review tag and the cleaned body", () => {
    const card = LegacySrMigrator.processWholeNote(reviewNote, "My Note");
    const out = LegacySrMigrator.renderTitleModeFile(card, "decks/review");
    expect(out.startsWith("---\ntags:\n  - decks/review\n---")).toBe(true);
    // Exactly one tag, in the decks/ namespace; no carried-over SR tags.
    expect(out.match(/^ {2}- /gm)).toHaveLength(1);
    expect(out).not.toContain("flashcards/cleancode/comments");
    // SR metadata stripped; body kept.
    expect(out).not.toContain("sr-due");
    expect(out).not.toContain("<!--SR:");
    expect(out).toContain("## A section");
    expect(out).toContain("Body content.");
    // No title heading — the filename is the front in title mode.
    expect(out).not.toContain("# My Note");
  });

  it("supports a subtag review tag", () => {
    const card = LegacySrMigrator.processWholeNote("Just a body.\n", "Note");
    const out = LegacySrMigrator.renderTitleModeFile(card, "decks/review/spanish");
    expect(out).toContain("  - decks/review/spanish");
    expect(out).toContain("Just a body.");
  });
});
