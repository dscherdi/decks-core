import initSqlJs, { type Database, type Statement } from "sql.js";
import { CREATE_TABLES_SQL } from "../../database/schemas";
import { DEFAULT_DECK_PROFILE, DEFAULT_PROFILE_ID, type DeckProfile } from "../../database/types";
import { generateFlashcardId } from "../../utils/hash";
import { FlashcardSynchronizer, type SyncResult } from "../FlashcardSynchronizer";

const NOW = "2026-10-10T00:00:00.000Z";
const PROFILE: DeckProfile = { ...DEFAULT_DECK_PROFILE, id: DEFAULT_PROFILE_ID, created: NOW, modified: NOW };
const DECK = "deck_numbers";

let db: Database;
let prepared: string[];
let freed: number;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(CREATE_TABLES_SQL);
  db.run(
    "INSERT INTO decks (id, name, filepath, tag, profile_id, created, modified) VALUES (?, ?, ?, '#decks', ?, ?, ?)",
    [DECK, "Numbers", "Numbers.md", DEFAULT_PROFILE_ID, NOW, NOW]
  );
  prepared = [];
  freed = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string): Statement => {
    prepared.push(sql);
    const stmt = prepare(sql);
    const free = stmt.free.bind(stmt);
    stmt.free = (): boolean => {
      freed++;
      return free();
    };
    return stmt;
  };
});

afterEach(() => db.close());

function sync(fileContent: string): SyncResult {
  return new FlashcardSynchronizer(db).syncFlashcardsForDeck({
    deckId: DECK,
    deckName: "Numbers",
    deckFilepath: "Numbers.md",
    deckConfig: PROFILE,
    fileContent,
  });
}

const note = (cards: Array<[string, string]>): string =>
  cards.map(([front, back]) => `## ${front}\n\n${back}\n`).join("\n");

const preparedLike = (fragment: string): number =>
  prepared.filter((sql) => sql.replace(/\s+/g, " ").includes(fragment)).length;

function row(id: string): Record<string, unknown> | undefined {
  const stmt = db.prepare("SELECT * FROM flashcards WHERE id = ?");
  stmt.bind([id]);
  const result = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return result;
}

function addReview(flashcardId: string, reviewedAt: string, intervalMinutes: number): void {
  db.run(
    `INSERT INTO review_logs (id, flashcard_id, last_reviewed_at, reviewed_at, rating, rating_label,
       old_state, new_state, new_stability, new_difficulty, new_repetitions, new_lapses,
       old_interval_minutes, new_interval_minutes, old_due_at, new_due_at, elapsed_days,
       retrievability, request_retention, maximum_interval_days, min_minutes,
       fsrs_weights_version, scheduler_version)
     VALUES (?, ?, ?, ?, 3, 'good', 'new', 'review', 7, 4, 2, 1, 0, ?, ?, ?, 0, 1, 0.9, 36500, 1, 'test', 'test')`,
    [`log_${flashcardId}`, flashcardId, reviewedAt, reviewedAt, intervalMinutes, reviewedAt, reviewedAt]
  );
}

const inTransaction = (): boolean => {
  try {
    db.run("BEGIN");
  } catch {
    return true;
  }
  db.run("ROLLBACK");
  return false;
};

const CARDS: Array<[string, string]> = [
  ["one", "uno"],
  ["two", "dos"],
  ["three", "tres"],
  ["four", "cuatro"],
];

describe("statements during a sync", () => {
  it("compiles each per-card statement once and frees every statement", () => {
    sync(note(CARDS));

    expect(preparedLike("INSERT INTO flashcards (")).toBe(1);
    expect(preparedLike("FROM review_logs WHERE flashcard_id = ?")).toBe(1);
    expect(preparedLike("FROM card_state_overlays WHERE flashcard_id = ?")).toBe(1);
    expect(freed).toBe(prepared.length);
    expect(inTransaction()).toBe(false);
  });

  it("reuses the update and delete statements on a resync", () => {
    sync(note(CARDS));
    prepared = [];
    freed = 0;

    sync(note([["one", "ein"], ["two", "zwei"]]));

    expect(preparedLike("UPDATE flashcards SET front = ?")).toBe(1);
    expect(preparedLike("DELETE FROM flashcards WHERE id = ?")).toBe(1);
    expect(freed).toBe(prepared.length);
    expect(row(generateFlashcardId("one"))?.back).toBe("ein");
    expect(row(generateFlashcardId("two"))?.back).toBe("zwei");
    expect(row(generateFlashcardId("three"))).toBeUndefined();
    expect(row(generateFlashcardId("four"))).toBeUndefined();
  });

  it("restores each card from its own history and overlay", () => {
    const [one, two, three] = ["one", "two", "three"].map((front) => generateFlashcardId(front));
    addReview(one, "2026-10-01T00:00:00.000Z", 1440);
    addReview(three, "2026-10-02T00:00:00.000Z", 4320);
    db.run("INSERT INTO card_state_overlays (flashcard_id, suspended_at, modified) VALUES (?, ?, ?)", [
      two,
      NOW,
      NOW,
    ]);

    sync(note(CARDS));

    expect(row(one)).toMatchObject({
      state: "review",
      interval: 1440,
      last_reviewed: "2026-10-01T00:00:00.000Z",
      due_date: "2026-10-02T00:00:00.000Z",
      suspended_at: null,
    });
    expect(row(two)).toMatchObject({ state: "new", interval: 0, last_reviewed: null, suspended_at: NOW });
    expect(row(three)).toMatchObject({
      state: "review",
      interval: 4320,
      last_reviewed: "2026-10-02T00:00:00.000Z",
      due_date: "2026-10-05T00:00:00.000Z",
      suspended_at: null,
    });
    expect(row(generateFlashcardId("four"))).toMatchObject({ state: "new", last_reviewed: null });
  });

  it("frees its statements when a write fails, keeping the writes before it", () => {
    db.run(
      "CREATE TRIGGER refuse BEFORE INSERT ON flashcards WHEN NEW.front = 'three' BEGIN SELECT RAISE(ABORT, 'refused'); END"
    );

    expect(() => sync(note(CARDS))).toThrow("Sync failed: refused");

    expect(freed).toBe(prepared.length);
    expect(inTransaction()).toBe(false);
    expect(row(generateFlashcardId("one"))).toBeDefined();
    expect(row(generateFlashcardId("two"))).toBeDefined();
    expect(row(generateFlashcardId("three"))).toBeUndefined();
  });
});
