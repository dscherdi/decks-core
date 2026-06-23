import { AnkiDeckRenderer } from "../AnkiDeckRenderer";
import type { AnkiParsedCard, AnkiScheduling } from "../AnkiTypes";

const NEW_SCHED: AnkiScheduling = {
  type: 0,
  queue: 0,
  due: 0,
  ivl: 0,
  factor: 0,
  reps: 0,
  lapses: 0,
  data: "{}",
};

function basic(partial: Partial<AnkiParsedCard>): AnkiParsedCard {
  return {
    noteId: 1,
    cardId: 10,
    ord: 0,
    isCloze: false,
    deckName: "Deck",
    front: "Front",
    back: "Back",
    notes: "",
    media: [],
    scheduling: NEW_SCHED,
    ...partial,
  };
}

describe("AnkiDeckRenderer", () => {
  it("renders one header-paragraph entry per card with a deck tag", () => {
    const cards = [
      basic({ deckName: "German::01 Hallo", front: "Hallo", back: "Hello" }),
      basic({ noteId: 2, cardId: 11, deckName: "German::01 Hallo", front: "Tschüss", back: "Bye" }),
    ];
    const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(decks).toHaveLength(1);
    const deck = decks[0];
    expect(deck.relativePath).toBe("German/01 Hallo");
    expect(deck.tag).toBe("decks/anki/german/01-hallo");
    expect(deck.content).toContain("tags:\n  - decks/anki/german/01-hallo");
    expect(deck.content).toContain("## Hallo\n\nHello");
    expect(deck.content).toContain("## Tschüss\n\nBye");
  });

  it("keeps forward and reverse templates as independent entries", () => {
    const cards = [
      basic({ ord: 0, front: "Das Wetter", back: "The weather" }),
      basic({ cardId: 11, ord: 1, front: "The weather", back: "Das Wetter" }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("## Das Wetter\n\nThe weather");
    expect(deck.content).toContain("## The weather\n\nDas Wetter");
  });

  it("collapses a cloze note's cards into a single entry", () => {
    const clozeCard = (ord: number, clozeText: string): AnkiParsedCard =>
      basic({
        cardId: 20 + ord,
        ord,
        isCloze: true,
        front: "Cloze header",
        back: "Du trinkst ==jeden Tag== ==Bier==.",
        clozeBody: "Du trinkst ==jeden Tag== ==Bier==.",
        clozeText,
        clozeOrder: ord,
      });
    const decks = AnkiDeckRenderer.render([clozeCard(0, "jeden Tag"), clozeCard(1, "Bier")], "decks/anki", 2);
    const occurrences = decks[0].content.split("## Cloze header").length - 1;
    expect(occurrences).toBe(1);
    expect(decks[0].content).toContain("Du trinkst ==jeden Tag== ==Bier==.");
  });

  it("splits cards across files mirroring the :: hierarchy", () => {
    const cards = [
      basic({ deckName: "German::01 Hallo", front: "a" }),
      basic({ noteId: 2, cardId: 11, deckName: "German::02 Wetter", front: "b" }),
    ];
    const decks = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(decks.map((d) => d.relativePath)).toEqual(["German/01 Hallo", "German/02 Wetter"]);
  });

  it("appends notes after a --- in header-paragraph format", () => {
    const cards = [basic({ front: "Hallo", back: "Hello", notes: "informal greeting" })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2, "header-paragraph");
    expect(deck.content).toContain("## Hallo\n\nHello\n\n---\n\ninformal greeting");
  });

  it("promotes notes into back when back is empty (no dangling ---)", () => {
    const cards = [basic({ front: "Hallo", back: "", notes: "only notes" })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2, "header-paragraph");
    expect(deck.content).toContain("## Hallo\n\nonly notes");
    expect(deck.content).not.toContain("---\n\n");
  });

  it("emits a 2-col table when no card has notes", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello" }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye" }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2, "table");
    expect(deck.content).toContain("| Front | Back |\n| --- | --- |");
    expect(deck.content).toContain("| Hallo | Hello |");
    expect(deck.content).not.toContain("| Notes |");
  });

  it("emits a 3-col table when any card has notes", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello", notes: "informal" }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye" }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2, "table");
    expect(deck.content).toContain("| Front | Back | Notes |\n| --- | --- | --- |");
    expect(deck.content).toContain("| Hallo | Hello | informal |");
    expect(deck.content).toContain("| Tschüss | Bye |  |");
  });

  it("emits a 1-col cloze table with the sentence as the cell", () => {
    const cloze = basic({
      isCloze: true,
      front: "header",
      back: "Du trinkst ==jeden Tag== Bier.",
      clozeBody: "Du trinkst ==jeden Tag== Bier.",
      clozeText: "jeden Tag",
      clozeOrder: 0,
    });
    const [deck] = AnkiDeckRenderer.render([cloze], "decks/anki", 2, "table");
    expect(deck.content).toContain("| Front |\n| --- |\n| Du trinkst ==jeden Tag== Bier. |");
  });

  it("escapes pipes and newlines in table cells", () => {
    const cards = [basic({ front: "a|b", back: "line1\nline2" })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2, "table");
    expect(deck.content).toContain("| a\\|b | line1<br>line2 |");
  });
});
