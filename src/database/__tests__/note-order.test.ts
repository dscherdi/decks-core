import initSqlJs, { type Database } from "sql.js";
import { CREATE_TABLES_SQL } from "../schemas";
import { DEFAULT_DECK_PROFILE, DEFAULT_PROFILE_ID, type DeckProfile } from "../types";
import { FlashcardSynchronizer } from "../../services/FlashcardSynchronizer";
import {
  NOTE_ORDER_PENDING_DECKS_SQL,
  ensureNoteOrderColumns,
  newCardOrderBy,
  noteOrderColumnStatements,
} from "../note-order";

const NOW = "2026-10-22T00:00:00.000Z";
const PROFILE: DeckProfile = { ...DEFAULT_DECK_PROFILE, id: DEFAULT_PROFILE_ID, created: NOW, modified: NOW };
const NOTE_PROFILE = "profile_note_order";
const GROWN_NOTE = "## One\n\n1\n\n## Two\n\n2\n\n## Three\n\n3\n";
const FIRST_WAVE = "## One\n\n1\n\n## Three\n\n3\n";

let db: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(CREATE_TABLES_SQL);
  db.run(
    `INSERT INTO deckprofiles (id, name, new_card_order, created, modified) VALUES (?, 'In note order', 'note', ?, ?)`,
    [NOTE_PROFILE, NOW, NOW]
  );
  addDeck("deck_a", "A.md");
});

afterEach(() => db.close());

function addDeck(id: string, path: string, profileId = DEFAULT_PROFILE_ID): void {
  db.run(
    "INSERT INTO decks (id, name, filepath, tag, profile_id, created, modified) VALUES (?, ?, ?, '#decks', ?, ?, ?)",
    [id, id, path, profileId, NOW, NOW]
  );
}

function sync(deckId: string, path: string, fileContent: string, reverseCards = false): void {
  const result = new FlashcardSynchronizer(db).syncFlashcardsForDeck({
    deckId,
    deckName: deckId,
    deckFilepath: path,
    deckConfig: PROFILE,
    fileContent,
    reverseCards,
  });
  if (!result.success) throw new Error("sync failed");
}

function column(sql: string, params: (string | number)[] = []): (string | number | null)[] {
  const result = db.exec(sql, params);
  return (result[0]?.values ?? []).map((row) => row[0] as string | number | null);
}

// Distinct first-sync times in the order rows were created, so "order added" has no ties.
function spreadAddedTimes(): void {
  db.run("UPDATE flashcards SET due_date = printf('2000-01-01T00:00:%02d.000Z', rowid)");
}

function placed(deckId: string): [string, number | null][] {
  const result = db.exec("SELECT front, note_position FROM flashcards WHERE deck_id = ? ORDER BY rowid", [deckId]);
  return (result[0]?.values ?? []).map(([front, position]) => [front as string, position as number | null]);
}

describe("note positions", () => {
  it("records where each card sits in the note", () => {
    sync("deck_a", "A.md", GROWN_NOTE);
    expect(placed("deck_a")).toEqual([
      ["One", 0],
      ["Two", 1],
      ["Three", 2],
    ]);
  });

  it("gives a card added to the middle its place, and moves the later cards without marking them modified", () => {
    sync("deck_a", "A.md", FIRST_WAVE);
    db.run("UPDATE flashcards SET modified = 'untouched' WHERE deck_id = 'deck_a'");

    sync("deck_a", "A.md", GROWN_NOTE);

    expect(placed("deck_a")).toEqual([
      ["One", 0],
      ["Three", 2],
      ["Two", 1],
    ]);
    expect(column("SELECT modified FROM flashcards WHERE front = 'Three'")).toEqual(["untouched"]);
  });

  it("places reverse cards after the note's own cards", () => {
    sync("deck_a", "A.md", "## One\n\nuno\n\n## Two\n\ndos\n", true);
    expect(column("SELECT front FROM flashcards WHERE deck_id = 'deck_a' ORDER BY note_position")).toEqual([
      "One",
      "Two",
      "uno",
      "dos",
    ]);
  });

  it("syncs a database that lacks the column, which a later open adds", () => {
    db.run("ALTER TABLE flashcards DROP COLUMN note_position");
    db.run("ALTER TABLE deckprofiles DROP COLUMN new_card_order");
    sync("deck_a", "A.md", GROWN_NOTE);
    expect(column("SELECT COUNT(*) FROM flashcards")).toEqual([3]);

    ensureNoteOrderColumns(db);
    ensureNoteOrderColumns(db);
    expect(column("SELECT COUNT(*) FROM flashcards WHERE note_position IS NULL")).toEqual([3]);
    expect(column("SELECT new_card_order FROM deckprofiles WHERE id = ?", [DEFAULT_PROFILE_ID])).toEqual(["created"]);
    expect(noteOrderColumnStatements(["id", "note_position"], ["id", "new_card_order"])).toEqual([]);
    expect(noteOrderColumnStatements([], [])).toEqual([]);
  });

  it("lists only note-order decks that still hold a card without a place", () => {
    addDeck("deck_b", "B.md", NOTE_PROFILE);
    sync("deck_a", "A.md", GROWN_NOTE);
    sync("deck_b", "B.md", GROWN_NOTE.replace(/## /g, "## B "));
    expect(column(NOTE_ORDER_PENDING_DECKS_SQL)).toEqual([]);

    db.run("UPDATE flashcards SET note_position = NULL");
    expect(column(NOTE_ORDER_PENDING_DECKS_SQL)).toEqual(["deck_b"]);

    sync("deck_b", "B.md", GROWN_NOTE.replace(/## /g, "## B "));
    expect(column(NOTE_ORDER_PENDING_DECKS_SQL)).toEqual([]);
  });
});

describe("new-card order", () => {
  function fronts(deckIds: string[], order: ReturnType<typeof newCardOrderBy>): string[] {
    const placeholders = deckIds.map(() => "?").join(",");
    return column(
      `SELECT front FROM flashcards WHERE deck_id IN (${placeholders}) AND state = 'new' ${order.sql}`,
      [...deckIds, ...order.params]
    ).map(String);
  }

  it("follows the note, or the order cards were added", () => {
    sync("deck_a", "A.md", FIRST_WAVE);
    sync("deck_a", "A.md", GROWN_NOTE);
    spreadAddedTimes();
    expect(fronts(["deck_a"], newCardOrderBy("note"))).toEqual(["One", "Two", "Three"]);
    expect(fronts(["deck_a"], newCardOrderBy("created"))).toEqual(["One", "Three", "Two"]);
    expect(fronts(["deck_a"], newCardOrderBy("random")).sort()).toEqual(["One", "Three", "Two"]);
  });

  it("takes a group's decks in the group's order, each in note order", () => {
    addDeck("deck_b", "B.md");
    sync("deck_b", "B.md", "## B2\n\nb\n");
    sync("deck_a", "A.md", FIRST_WAVE);
    sync("deck_b", "B.md", "## B1\n\na\n\n## B2\n\nb\n");
    sync("deck_a", "A.md", GROWN_NOTE);
    spreadAddedTimes();

    expect(fronts(["deck_a", "deck_b"], newCardOrderBy("note", ["deck_a", "deck_b"]))).toEqual([
      "One",
      "Two",
      "Three",
      "B1",
      "B2",
    ]);
    expect(fronts(["deck_a", "deck_b"], newCardOrderBy("created", ["deck_a", "deck_b"]))).toEqual([
      "B2",
      "One",
      "Three",
      "B1",
      "Two",
    ]);
  });

  it("puts cards without a place after the placed ones of their deck", () => {
    sync("deck_a", "A.md", GROWN_NOTE);
    db.run("UPDATE flashcards SET note_position = NULL WHERE front = 'One'");
    expect(fronts(["deck_a"], newCardOrderBy("note"))).toEqual(["Two", "Three", "One"]);
  });
});
