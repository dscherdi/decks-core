import type { Database } from "sql.js";
import { DEFAULT_DECK_PROFILE, DEFAULT_PROFILE_ID, type DeckProfile, type Flashcard, type FlashcardType } from "../../../database/types";
import { encodeAnchorValue } from "../../../utils/anchors";
import { activeMaskIdForCard } from "../../occlusion/OcclusionV2";
import { generateFlashcardId } from "../../../utils/hash";
import { FlashcardSynchronizer } from "../../FlashcardSynchronizer";
import { buildDirectoryCards, sortCardsInNoteOrder, type NoteOrderOptions } from "../export";
import { mainDb } from "./helpers";

const NOW = "2026-10-22T00:00:00.000Z";
const DECK = "deck_bio";
const PROFILE: DeckProfile = { ...DEFAULT_DECK_PROFILE, id: DEFAULT_PROFILE_ID, created: NOW, modified: NOW };
const EXAM_PROFILE: DeckProfile = { ...PROFILE, examEnabled: true };

let db: Database;

beforeEach(async () => {
  db = await mainDb();
  db.run(
    "INSERT INTO decks (id, name, filepath, tag, profile_id, created, modified) VALUES (?, ?, ?, '#decks', ?, ?, ?)",
    [DECK, "Bio", "Bio.md", DEFAULT_PROFILE_ID, NOW, NOW]
  );
});

afterEach(() => db.close());

function sync(fileContent: string, profile: DeckProfile = PROFILE, reverseCards = false): void {
  const result = new FlashcardSynchronizer(db).syncFlashcardsForDeck({
    deckId: DECK,
    deckName: "Bio",
    deckFilepath: "Bio.md",
    deckConfig: profile,
    fileContent,
    fileTitle: "Bio",
    reverseCards,
    examEnabled: profile.examEnabled === true,
  });
  if (!result.success) throw new Error("sync failed");
}

// The deck's rows as the plugin reads them: in the order they were first synced.
function rows(): Flashcard[] {
  const result = db.exec(
    "SELECT id, front, back, type, breadcrumb, cloze_order, anchor FROM flashcards WHERE deck_id = ? ORDER BY created, rowid",
    [DECK]
  );
  return (result[0]?.values ?? []).map(([id, front, back, type, breadcrumb, clozeOrder, anchor]) => ({
    id: id as string,
    deckId: DECK,
    front: front as string,
    back: back as string,
    type: type as FlashcardType,
    sourceFile: "Bio.md",
    contentHash: "",
    breadcrumb: (breadcrumb as string) ?? "",
    notes: "",
    hint: "",
    clozeText: null,
    clozeOrder: (clozeOrder as number | null) ?? null,
    anchor: (anchor as string | null) ?? null,
    state: "new",
    dueDate: NOW,
    interval: 0,
    repetitions: 0,
    difficulty: 5,
    stability: 2.5,
    lapses: 0,
    lastReviewed: null,
    created: NOW,
    modified: NOW,
    tags: [],
  }));
}

const options = (profile: DeckProfile = PROFILE): NoteOrderOptions => ({
  headerLevels: [profile.headerLevel],
  fileTitle: "Bio",
  clozeEnabled: profile.clozeEnabled,
  examEnabled: profile.examEnabled === true,
});

const label = (card: Flashcard): string =>
  card.type === "image-occlusion-v2" ? `mask ${activeMaskIdForCard(card) ?? "?"}` : card.front;

const section = (front: string, back: string): string => `## ${front}\n\n${back}\n`;

const occlusion = [
  "## Heart",
  "",
  "```decks-occlusion",
  "image: '[[heart.png]]'",
  "masks:",
  "  - { id: m1, x: 10, y: 20, w: 15, h: 8, answer: Aorta }",
  "  - { id: m2, x: 50, y: 30, w: 12, h: 6, answer: Atrium }",
  "```",
  "",
].join("\n");

describe("sortCardsInNoteOrder", () => {
  it("puts a card added to the middle of a note back in its place", () => {
    sync([section("Cell", "smallest unit"), section("Enzyme", "catalyst")].join("\n"));
    const note = [section("Cell", "smallest unit"), section("Membrane", "lipid bilayer"), section("Enzyme", "catalyst")].join("\n");
    sync(note);
    expect(rows().map(label)).toEqual(["Cell", "Enzyme", "Membrane"]);

    const sorted = sortCardsInNoteOrder(rows(), note, options());
    expect(sorted.map(label)).toEqual(["Cell", "Membrane", "Enzyme"]);
    expect(new Set(sorted.map((card) => card.id))).toEqual(new Set(rows().map((card) => card.id)));

    const exported = buildDirectoryCards("someone/bio", sorted, () => null);
    expect(exported.cards.map((card) => [card.position, card.front])).toEqual([
      [0, "Cell"],
      [1, "Membrane"],
      [2, "Enzyme"],
    ]);
  });

  it("places occlusion cards where their block sits in the note", () => {
    const note = [section("Cell", "smallest unit"), occlusion, section("Enzyme", "catalyst")].join("\n");
    sync(note);
    expect(rows().map(label)).toEqual(["Cell", "Enzyme", "mask m1", "mask m2"]);
    expect(sortCardsInNoteOrder(rows(), note, options()).map(label)).toEqual(["Cell", "mask m1", "mask m2", "Enzyme"]);
  });

  it("orders an exam deck's questions and exercises as the note does", () => {
    const question = (front: string, right: string, wrong: string) => `## ${front}\n- [x] ${right}\n- [ ] ${wrong}\n`;
    const exercise = [
      "## Lesen Teil 1",
      "Sie lesen diesen Text.",
      "> [!passage] Zellen",
      "> Zellen teilen sich.",
      "",
      "### Zellen …",
      "- [x] teilen sich.",
      "- [ ] schmelzen.",
      "",
      "### Kerne …",
      "- [x] enthalten DNA.",
      "- [ ] enthalten Luft.",
      "",
    ].join("\n");
    const first = question("Organelle der Atmung?", "Mitochondrium", "Ribosom");
    const last = question("Träger der Erbinformation?", "DNA", "Stärke");
    sync([first, last].join("\n"), EXAM_PROFILE);
    const note = [first, exercise, last].join("\n");
    sync(note, EXAM_PROFILE);
    expect(rows().map(label)).toEqual(["Organelle der Atmung?", "Träger der Erbinformation?", "Lesen Teil 1"]);
    expect(sortCardsInNoteOrder(rows(), note, options(EXAM_PROFILE)).map(label)).toEqual([
      "Organelle der Atmung?",
      "Lesen Teil 1",
      "Träger der Erbinformation?",
    ]);
  });

  it("keeps reverse cards after the note's cards, each in note order", () => {
    const head = "---\nreverse: true\n---\n";
    sync(head + [section("Cell", "smallest unit"), section("Enzyme", "catalyst")].join("\n"), PROFILE, true);
    const note = head + [section("Cell", "smallest unit"), section("Membrane", "lipid bilayer"), section("Enzyme", "catalyst")].join("\n");
    sync(note, PROFILE, true);
    expect(sortCardsInNoteOrder(rows(), note, options()).map(label)).toEqual([
      "Cell",
      "Membrane",
      "Enzyme",
      "smallest unit",
      "lipid bilayer",
      "catalyst",
    ]);
  });

  it("tells identical cards apart by their tokens", () => {
    const first = generateFlashcardId("first copy");
    const second = generateFlashcardId("second copy");
    const token = (id: string) => `%%dk:h:${encodeAnchorValue("a", [id])}%%`;
    const note = [
      `## Osmosis\n\nwater moves\n${token(first)}\n`,
      section("Diffusion", "particles spread"),
      `## Osmosis\n\nwater moves\n${token(second)}\n`,
    ].join("\n");
    sync(note);
    const shuffled = [...rows()].reverse();
    expect(shuffled.map((card) => card.id)).toEqual(expect.arrayContaining([first, second]));
    expect(sortCardsInNoteOrder(shuffled, note, options()).map((card) => card.id)).toEqual([
      first,
      generateFlashcardId("Diffusion"),
      second,
    ]);
  });

  it("keeps rows the note no longer holds at the end, in their order", () => {
    const note = [section("Cell", "smallest unit"), section("Enzyme", "catalyst")].join("\n");
    sync(note);
    const [cell, enzyme] = rows();
    const gone = (front: string): Flashcard => ({ ...cell, id: generateFlashcardId(front), front, anchor: null });
    const sorted = sortCardsInNoteOrder([gone("Old one"), enzyme, gone("Old two"), cell], note, options());
    expect(sorted.map(label)).toEqual(["Cell", "Enzyme", "Old one", "Old two"]);
  });
});
