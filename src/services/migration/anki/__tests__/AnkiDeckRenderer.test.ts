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
    kind: partial.isCloze ? "cloze" : "basic",
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

  it("renders cloze cards as a 1-col table per deck, deduped by note", () => {
    const clozeCard = (ord: number, clozeText: string): AnkiParsedCard =>
      basic({
        cardId: 20 + ord,
        ord,
        isCloze: true,
        front: "Du trinkst ==jeden Tag== ==Bier==.",
        back: "Du trinkst ==jeden Tag== ==Bier==.",
        clozeBody: "Du trinkst ==jeden Tag== ==Bier==.",
        clozeText,
        clozeOrder: ord,
      });
    const decks = AnkiDeckRenderer.render([clozeCard(0, "jeden Tag"), clozeCard(1, "Bier")], "decks/anki", 2);
    expect(decks[0].content).toContain("| Front |\n| --- |");
    // Same note → one row.
    const occurrences = decks[0].content.split("Du trinkst ==jeden Tag== ==Bier==.").length - 1;
    expect(occurrences).toBe(1);
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
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("## Hallo\n\nHello\n\n---\n\ninformal greeting");
  });

  it("promotes notes into back when back is empty (no dangling ---)", () => {
    const cards = [basic({ front: "Hallo", back: "", notes: "only notes" })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("## Hallo\n\nonly notes");
    expect(deck.content).not.toContain("---\n\n");
  });

  it("aggregates table-routed cards (no notes) into a single 2-col table", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello", tableLayout: true }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye", tableLayout: true }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |\n| --- | --- |");
    expect(deck.content).toContain("| Hallo | Hello |");
    expect(deck.content).toContain("| Tschüss | Bye |");
    expect(deck.content).not.toContain("| Notes |");
    // One aggregated table, not one per card.
    expect(deck.content.split("| Front | Back |").length - 1).toBe(1);
  });

  it("groups table cards by structure: a 2-col table and a separate 3-col table", () => {
    const cards = [
      basic({ front: "Hallo", back: "Hello", notes: "informal", tableLayout: true }),
      basic({ noteId: 2, cardId: 11, front: "Tschüss", back: "Bye", tableLayout: true }),
    ];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back | Notes |\n| --- | --- | --- |");
    expect(deck.content).toContain("| Hallo | Hello | informal |");
    expect(deck.content).toContain("| Front | Back |\n| --- | --- |");
    expect(deck.content).toContain("| Tschüss | Bye |");
    // The no-notes card is NOT padded into the 3-col table.
    expect(deck.content).not.toContain("| Tschüss | Bye |  |");
  });

  it("renders a no-front media card as a table row (front cell = the image)", () => {
    const card = basic({ front: "![[img1.jpg]]", back: "![[img2.jpg]]", tableLayout: true });
    const [deck] = AnkiDeckRenderer.render([card], "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |\n| --- | --- |");
    expect(deck.content).toContain("| ![[img1.jpg]] | ![[img2.jpg]] |");
  });

  it("collapses a deck with >= 50 header-paragraph basics into a table", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "line a\nline b\nline c", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |");
    expect(deck.content).not.toContain("## Q0"); // no header-paragraph sections
  });

  it("keeps < 50 header-paragraph basics as header-paragraph sections", () => {
    const cards = Array.from({ length: 49 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "line a\nline b", tableLayout: false })
    );
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("## Q0");
    expect(deck.content).not.toContain("| Front | Back |");
  });

  it("keeps empty-back cards header-paragraph even above the volume threshold", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      basic({ noteId: i + 1, cardId: 100 + i, front: `Q${i}`, back: "ans", tableLayout: false })
    );
    cards.push(basic({ noteId: 999, cardId: 999, front: "OnlyFront", back: "", notes: "a note", tableLayout: false }));
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| Front | Back |"); // the 50 went into a table
    expect(deck.content).toContain("## OnlyFront"); // the empty-back one stayed header-paragraph
  });

  it("renders a templated cloze (with extras) as a tag-bound table", () => {
    const cloze = basic({
      isCloze: true,
      front: "Du trinkst ==jeden Tag== Bier.",
      back: "Du trinkst ==jeden Tag== Bier.",
      clozeBody: "Du trinkst ==jeden Tag== Bier.",
      clozeText: "jeden Tag",
      clozeOrder: 0,
      templateTag: "anki-tpl-cloze/m",
      templateRow: { headers: ["Text", "Extra"], cells: ["Du trinkst ==jeden Tag== Bier.", "![[img.jpg]]"] },
    });
    const [deck] = AnkiDeckRenderer.render([cloze], "decks/anki", 2);
    expect(deck.content).toContain("#anki-tpl-cloze/m");
    expect(deck.content).toContain("| Text | Extra |");
    expect(deck.content).toContain("| Du trinkst ==jeden Tag== Bier. | ![[img.jpg]] |");
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
    const [deck] = AnkiDeckRenderer.render([cloze], "decks/anki", 2);
    expect(deck.content).toContain("| Front |\n| --- |\n| Du trinkst ==jeden Tag== Bier. |");
  });

  it("escapes pipes and newlines in table cells", () => {
    const cards = [basic({ front: "a|b", back: "line1\nline2", tableLayout: true })];
    const [deck] = AnkiDeckRenderer.render(cards, "decks/anki", 2);
    expect(deck.content).toContain("| a\\|b | line1<br>line2 |");
  });

  it("renders template cards as a tag-bound multi-field table", () => {
    const tpl = basic({
      kind: "template",
      deckName: "Vocab",
      front: "火",
      back: "ひ",
      templateTag: "anki-tpl/vocab-0",
      templateRow: { headers: ["Word", "Reading", "Meaning"], cells: ["火", "ひ", "fire"] },
    });
    const [deck] = AnkiDeckRenderer.render([tpl], "decks/anki", 2);
    expect(deck.content).toContain("## Vocab #anki-tpl/vocab-0");
    expect(deck.content).toContain("| Word | Reading | Meaning |");
    expect(deck.content).toContain("| 火 | ひ | fire |");
  });

  it("renders occlusion cards as one decks-occlusion block per image", () => {
    const occ = (maskId: string): AnkiParsedCard =>
      basic({
        kind: "occlusion",
        deckName: "Anatomy",
        front: "![[heart.png]]",
        back: "",
        imageRef: "[[heart.png]]",
        imagePath: "heart.png",
        maskId,
        masks: [
          { id: "m1", x: 10, y: 20, w: 15, h: 8, answer: "" },
          { id: "m2", x: 50, y: 30, w: 12, h: 6, answer: "" },
        ],
      });
    const [deck] = AnkiDeckRenderer.render([occ("m1"), occ("m2")], "decks/anki", 2);
    expect(deck.content).toContain("```decks-occlusion");
    expect(deck.content).toContain("image: '[[heart.png]]'");
    expect(deck.content).toContain("id: m1");
    expect(deck.content).toContain("id: m2");
    // One block for the shared image (not one per mask).
    expect(deck.content.split("```decks-occlusion").length - 1).toBe(1);
  });
});
