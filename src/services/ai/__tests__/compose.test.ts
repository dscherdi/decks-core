import {
  buildHeaderParagraphCard,
  buildTableContent,
  sourcePageNote,
  withSourcePage,
} from "../compose";
import { FlashcardParser } from "../../FlashcardParser";
import type { GeneratedCard } from "../generation-prompt";

const card = (over: Partial<GeneratedCard> = {}): GeneratedCard => ({
  front: "What does the variance measure?",
  back: "The mean squared deviation from the mean.",
  notes: "",
  ...over,
});

describe("withSourcePage", () => {
  it("leaves a card with no page untouched", () => {
    const c = card();
    expect(withSourcePage(c)).toBe(c);
  });

  it("writes the page into the notes when there are none", () => {
    expect(withSourcePage(card({ page: 70 })).notes).toBe("p. 70");
  });

  it("appends to existing notes rather than replacing them", () => {
    const out = withSourcePage(card({ page: 70, notes: "Bessel correction." }));
    expect(out.notes).toBe("Bessel correction.\n\np. 70");
  });
});

describe("saved markdown carries the page", () => {
  it("header+paragraph keeps it recoverable as the card's notes", () => {
    const block = buildHeaderParagraphCard(card({ page: 70 }), 2);
    expect(block).toContain("p. 70");

    // The page has to survive the round trip, not merely be written: the parser
    // is what a later coverage pass would read it back with.
    const { notes } = FlashcardParser.extractHeaderParagraphNotes(
      block.split("\n").slice(1).join("\n").trim(),
    );
    expect(notes).toContain("p. 70");
  });

  it("header+paragraph hides it in a comment, with no stray rule under the answer", () => {
    const block = buildHeaderParagraphCard(card({ page: 70 }), 2);
    expect(block).toContain("%%p. 70%%");
    expect(block).not.toContain("---");

    const withNotes = buildHeaderParagraphCard(card({ page: 70, notes: "Bessel correction." }), 2);
    const { back, notes } = FlashcardParser.extractHeaderParagraphNotes(
      withNotes.split("\n").slice(1).join("\n").trim(),
    );
    expect(back).toBe("The mean squared deviation from the mean.");
    expect(notes).toContain("Bessel correction.");
    expect(notes).toContain("p. 70");
  });

  it("a table keeps a Notes column when asked, for rows that will join it", () => {
    const table = buildTableContent([card()], 2, "Streumaße", { notesColumn: "always" });
    expect(table).toContain("| Front | Back | Notes |");
    expect(table).toContain("| What does the variance measure? | The mean squared deviation from the mean. |  |");
  });

  it("a table grows a Notes column for it", () => {
    const table = buildTableContent([card({ page: 70 })], 2, "Streumaße");
    expect(table).toContain("| Front | Back | Notes |");
    expect(table).toContain("p. 70");
  });

  it("a table with no pages and no notes stays two columns", () => {
    const table = buildTableContent([card()], 2, "Streumaße");
    expect(table).toContain("| Front | Back |");
    expect(table).not.toContain("| Notes |");
  });
});

describe("sourcePageNote", () => {
  it("reads the same way the source labels its pages", () => {
    // The label the model is shown and the note the user ends up with should not
    // be two different vocabularies for the same fact.
    expect(sourcePageNote(70)).toBe("p. 70");
  });
});
