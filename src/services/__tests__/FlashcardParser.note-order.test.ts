import { FlashcardParser } from "../FlashcardParser";

const NOTE = [
  "## Alpha",
  "",
  "first",
  "",
  "## Heart",
  "",
  "```decks-occlusion",
  "image: '[[heart.png]]'",
  "masks:",
  "  - { id: m1, x: 10, y: 20, w: 15, h: 8, answer: Aorta }",
  "  - { id: m2, x: 50, y: 30, w: 12, h: 6, answer: Atrium }",
  "```",
  "",
  "## Words",
  "",
  "| Front | Back |",
  "| --- | --- |",
  "| Hund | dog |",
  "",
  "## Gamma",
  "",
  "last",
].join("\n");

const fronts = (cards: Array<{ type: string; front: string }>) =>
  cards.map((card) => (card.type === "image-occlusion-v2" ? "occlusion" : card.front));

describe("FlashcardParser.parseInNoteOrder", () => {
  it("puts occlusion cards where their block sits in the note", () => {
    expect(fronts(FlashcardParser.parseInNoteOrder(NOTE, 2))).toEqual([
      "Alpha",
      "occlusion",
      "occlusion",
      "Hund",
      "Gamma",
    ]);
  });

  it("returns the same cards as the plain parse, which keeps occlusion cards first", () => {
    const plain = FlashcardParser.parseFlashcardsFromContent(NOTE, 2);
    expect(fronts(plain)).toEqual(["occlusion", "occlusion", "Alpha", "Hund", "Gamma"]);
    expect(new Set(FlashcardParser.parseInNoteOrder(NOTE, 2))).toEqual(new Set(plain));
  });

  it("keeps a title-mode note's own card ahead of its occlusion blocks", () => {
    const note = ["Body text", "", "```decks-occlusion", "image: '[[heart.png]]'", "masks:", "  - { id: m1, x: 1, y: 1, w: 5, h: 5 }", "```"].join("\n");
    expect(fronts(FlashcardParser.parseInNoteOrder(note, 0, "Cardiology"))).toEqual(["Cardiology", "occlusion"]);
  });
});
