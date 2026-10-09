import { AnchorStamper } from "../AnchorStamper";
import { FlashcardParser, type ParsedFlashcard } from "../FlashcardParser";
import { classifyExamBody } from "../ExamClassifier";
import type { NoteAccess } from "../NoteAccess";
import type { IDatabaseService } from "../../database/DatabaseService.interface";
import type { Flashcard } from "../../database/types";
import { cardIdForKey, encodeAnchorValue } from "../../utils/anchors";
import { generateClozeFlashcardId, generateFlashcardId } from "../../utils/hash";

const PATH = "A2 Practice Exam.md";

const parse = (content: string): ParsedFlashcard[] =>
  FlashcardParser.parseFlashcardsFromContent(content, 2, undefined, true, true);

const HEADING_FORM = [
  "---",
  "tags: [flashcards]",
  "---",
  "# Lesen",
  "",
  "## Lesen Teil 1",
  "Sie lesen in einer Zeitung diesen Text.",
  "> [!passage] Der TV-Koch Stefan Berger",
  "> Bei Stefan Berger gibt es Gerichte.",
  "",
  "### Die Gäste im Lokal …",
  "- [ ] finden immer einen Tisch.",
  "- [x] sollen Plätze reservieren.",
  "%%Steht im Text.%%",
  "",
  "### Wie heißt der Koch mit Vornamen?",
  "Stefan",
  "%%Der Vorname steht im Titel.%%",
  "",
  "### Ergänzen Sie den Satz.",
  "Das Lokal ist ==klein==.",
  "",
  "## Was ist das Gegenteil von alt?",
  "- [x] neu",
  "- [ ] groß",
  "%%Neu ist das Gegenteil.%%",
  "",
  "## Ergänzen Sie.",
  "Ich ==wohne== in Berlin.",
  "",
].join("\n");

const PARAGRAPH_FORM = [
  "## Der TV-Koch Stefan Berger",
  "Sie lesen in einer Zeitung diesen Text.",
  "Bei Stefan Berger gibt es Gerichte.",
  "",
  "Die Gäste im Lokal …",
  "- [ ] finden immer einen Tisch.",
  "- [x] sollen Plätze reservieren.",
  "%%Reservieren steht im Text.%%",
  "",
  "Stefan Berger möchte …",
  "- [x] nur ein Restaurant haben.",
  "- [ ] ein neues Restaurant eröffnen.",
  "",
  "---",
  "Lesen Teil 1, Aufgabe 1.",
  "",
  "### Quelle",
  "Zeitung, 2026.",
  "",
].join("\n");

function memoryNotes(files: Record<string, string>): NoteAccess {
  return {
    read: async (p) => files[p] ?? null,
    process: async (p, edit) => {
      if (files[p] !== undefined) files[p] = edit(files[p]);
    },
    mtime: async () => 1,
    readProperty: async () => null,
    writeProperty: async () => {},
  };
}

type StamperDb = Pick<
  IDatabaseService,
  | "getAnchorBinding"
  | "insertAnchorBindings"
  | "setFlashcardAnchor"
  | "getFlashcardById"
  | "getDeckLastSyncedMtime"
  | "setDeckLastSyncedMtime"
>;

class FakeDb implements StamperDb {
  bindings = new Map<string, string>();
  async getAnchorBinding(anchor: string): Promise<string | null> {
    return this.bindings.get(anchor) ?? null;
  }
  async insertAnchorBindings(rows: { anchor: string; flashcardId: string }[]): Promise<void> {
    for (const row of rows) if (!this.bindings.has(row.anchor)) this.bindings.set(row.anchor, row.flashcardId);
  }
  async setFlashcardAnchor(): Promise<void> {}
  async getFlashcardById(): Promise<Flashcard | null> {
    return null;
  }
  async getDeckLastSyncedMtime(): Promise<number> {
    return 0;
  }
  async setDeckLastSyncedMtime(): Promise<void> {}
}

/** The id the synchronizer derives from content when a card has no token. */
function contentId(parsed: ParsedFlashcard): string {
  return parsed.type === "cloze"
    ? generateClozeFlashcardId(parsed.front, parsed.clozeText ?? "", parsed.clozeOrder ?? 0)
    : generateFlashcardId(parsed.front);
}

function toCard(parsed: ParsedFlashcard): Flashcard {
  const now = new Date().toISOString();
  return {
    id: contentId(parsed),
    deckId: "deck_1",
    front: parsed.front,
    back: parsed.back,
    type: parsed.type,
    sourceFile: PATH,
    contentHash: "hash",
    breadcrumb: parsed.breadcrumb,
    notes: parsed.notes,
    tags: parsed.tags,
    hint: "",
    clozeText: parsed.clozeText ?? null,
    clozeOrder: parsed.clozeOrder ?? null,
    anchor: null,
    state: "new",
    dueDate: now,
    interval: 0,
    repetitions: 0,
    difficulty: 5,
    stability: 0,
    lapses: 0,
    lastReviewed: null,
    suspendedAt: null,
    buriedUntil: null,
    created: now,
    modified: now,
  };
}

function setup(content: string): { files: Record<string, string>; stamper: AnchorStamper } {
  const files = { [PATH]: content };
  const db: StamperDb = new FakeDb();
  return { files, stamper: new AnchorStamper(memoryNotes(files), db as IDatabaseService) };
}

function exerciseOf(cards: ParsedFlashcard[]): ParsedFlashcard {
  const found = cards.find((card) => card.type === "multiple-choice" && classifyExamBody(card.back).kind === "exercise");
  if (!found) throw new Error("no exercise card");
  return found;
}

const qToken = (id: string): string => `%%dk:q:${encodeAnchorValue("a", [id])}%%`;

describe("AnchorStamper exercises", () => {
  it.each([
    ["heading form", HEADING_FORM],
    ["paragraph and checklist form", PARAGRAPH_FORM],
  ])("stamps a %s exercise so its id comes back from the token", async (_label, note) => {
    const before = exerciseOf(parse(note));
    const card = toCard(before);
    const { files, stamper } = setup(note);

    const result = await stamper.stampFileBatch(PATH, [card]);

    expect(result.outcomes[0].ok).toBe(true);
    expect(files[PATH].split(qToken(card.id))).toHaveLength(2);
    const after = exerciseOf(parse(files[PATH]));
    expect(after.anchorKey).toBeDefined();
    expect(cardIdForKey(after.anchorKey ?? "")).toBe(card.id);
    expect(after.back).toBe(before.back);
    expect(after.notes).toBe(before.notes);
    expect(classifyExamBody(after.back)).toEqual(classifyExamBody(before.back));
  });

  it("writes the token as its own paragraph after the last question, inside the card", async () => {
    const card = toCard(exerciseOf(parse(HEADING_FORM)));
    const { files, stamper } = setup(HEADING_FORM);

    await stamper.stampFileBatch(PATH, [card]);

    expect(files[PATH]).toContain(`Das Lokal ist ==klein==.\n\n${qToken(card.id)}\n\n## Was ist das Gegenteil von alt?`);
  });

  it("stops at a deeper heading the parser does not read as a question", async () => {
    const card = toCard(exerciseOf(parse(PARAGRAPH_FORM)));
    const { files, stamper } = setup(PARAGRAPH_FORM);

    await stamper.stampFileBatch(PATH, [card]);

    expect(files[PATH]).toContain(`Lesen Teil 1, Aufgabe 1.\n\n${qToken(card.id)}\n\n### Quelle`);
  });

  it("keeps the id the exercise had before it carried a token", async () => {
    const before = exerciseOf(parse(HEADING_FORM));
    const card = toCard(before);
    const { files, stamper } = setup(HEADING_FORM);

    await stamper.stampFileBatch(PATH, [card]);

    const after = exerciseOf(parse(files[PATH]));
    expect(cardIdForKey(after.anchorKey ?? "")).toBe(generateFlashcardId(before.front));
  });

  it("stamps every card of an exam note in one batch", async () => {
    const parsed = parse(HEADING_FORM);
    expect(parsed.map((card) => card.type)).toEqual(["multiple-choice", "multiple-choice", "cloze"]);
    const cards = parsed.map(toCard);
    const { files, stamper } = setup(HEADING_FORM);

    const result = await stamper.stampFileBatch(PATH, cards);

    expect(result.stamped).toBe(cards.length);
    const reparsed = parse(files[PATH]);
    expect(reparsed.map((card) => cardIdForKey(card.anchorKey ?? ""))).toEqual(cards.map((card) => card.id));
  });

  it("rewrites a minted q token in place", async () => {
    const minted = PARAGRAPH_FORM.replace("eröffnen.\n", "eröffnen.\n%%dk:q:mine2%%\n");
    const card = toCard(exerciseOf(parse(minted)));
    const { files, stamper } = setup(minted);

    await stamper.stampFileBatch(PATH, [card]);

    expect(files[PATH]).toContain(`eröffnen.\n${qToken(card.id)}\n`);
    expect(files[PATH].match(/%%dk:q:/g)).toHaveLength(1);
  });

  it("leaves the note alone once the token is there", async () => {
    const card = toCard(exerciseOf(parse(HEADING_FORM)));
    const { files, stamper } = setup(HEADING_FORM);
    await stamper.stampFileBatch(PATH, [card]);
    const stamped = files[PATH];

    const again = await stamper.stampFileBatch(PATH, [card]);

    expect(again.outcomes[0]).toEqual({ ok: true, anchorKey: card.anchor, adopted: true });
    expect(files[PATH]).toBe(stamped);
  });

  it("skips an exercise edited since it was read", async () => {
    const card = toCard(exerciseOf(parse(HEADING_FORM)));
    const edited = HEADING_FORM.replace("Stefan\n", "Stefan Berger\n");
    const { files, stamper } = setup(edited);

    const result = await stamper.stampFileBatch(PATH, [card]);

    expect(result.outcomes[0]).toEqual({ ok: false, reason: "stale" });
    expect(files[PATH]).toBe(edited);
  });
});
