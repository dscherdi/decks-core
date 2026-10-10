import initSqlJs, { type Database } from "sql.js";
import { CREATE_TABLES_SQL } from "../../database/schemas";
import { DEFAULT_DECK_PROFILE, DEFAULT_PROFILE_ID, type DeckProfile } from "../../database/types";
import { generateFlashcardId } from "../../utils/hash";
import { encodeAnchorValue } from "../../utils/anchors";
import { FlashcardSynchronizer, type SyncResult } from "../FlashcardSynchronizer";

const PASSEN = "passen (passt · hat gepasst)";
const KUESSEN = "küssen (küsst · hat geküsst)";
const NOW = "2026-10-10T00:00:00.000Z";
const PROFILE: DeckProfile = { ...DEFAULT_DECK_PROFILE, id: DEFAULT_PROFILE_ID, created: NOW, modified: NOW };

let db: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(CREATE_TABLES_SQL);
  for (const id of ["deck_a1", "deck_b1"]) {
    db.run(
      "INSERT INTO decks (id, name, filepath, tag, profile_id, created, modified) VALUES (?, ?, ?, '#decks', ?, ?, ?)",
      [id, id, `${id}.md`, DEFAULT_PROFILE_ID, NOW, NOW]
    );
  }
});

afterEach(() => db.close());

function sync(deckId: string, fileContent: string): SyncResult {
  return new FlashcardSynchronizer(db).syncFlashcardsForDeck({
    deckId,
    deckName: deckId,
    deckFilepath: `${deckId}.md`,
    deckConfig: PROFILE,
    fileContent,
  });
}

function fronts(deckId: string): string[] {
  const result = db.exec("SELECT front FROM flashcards WHERE deck_id = ? ORDER BY front", [deckId]);
  return (result[0]?.values ?? []).map((row) => row[0] as string);
}

function logCount(flashcardId: string): number {
  return db.exec("SELECT COUNT(*) FROM review_logs WHERE flashcard_id = ?", [flashcardId])[0]
    .values[0][0] as number;
}

function addReview(flashcardId: string, reviewedAt: string): void {
  db.run(
    `INSERT INTO review_logs (id, flashcard_id, last_reviewed_at, reviewed_at, rating, rating_label,
       old_state, new_state, new_stability, old_interval_minutes, new_interval_minutes, old_due_at,
       new_due_at, elapsed_days, retrievability, request_retention, maximum_interval_days,
       min_minutes, fsrs_weights_version, scheduler_version)
     VALUES (?, ?, ?, ?, 3, 'good', 'new', 'review', 7, 0, 4320, ?, ?, 0, 1, 0.9, 36500, 1, 'test', 'test')`,
    [`log_${flashcardId}_${reviewedAt}`, flashcardId, reviewedAt, reviewedAt, reviewedAt, reviewedAt]
  );
}

describe("id collisions across decks", () => {
  it("hashes the two fronts to one content id", () => {
    expect(generateFlashcardId(KUESSEN)).toBe(generateFlashcardId(PASSEN));
  });

  it("reports a card whose id a different card in another deck already holds", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    const result = sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n\n## sehen\n\nto see\n`);

    expect(result.idCollisions).toEqual([
      { id: generateFlashcardId(PASSEN), fronts: [PASSEN, KUESSEN] },
    ]);
    expect(result.duplicatesSkipped).toBe(1);
    expect(fronts("deck_a1")).toEqual([PASSEN]);
    expect(fronts("deck_b1")).toEqual(["sehen"]);
  });

  it("reports it whichever note syncs first", () => {
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);
    const result = sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);

    expect(result.idCollisions).toEqual([
      { id: generateFlashcardId(PASSEN), fronts: [KUESSEN, PASSEN] },
    ]);
    expect(fronts("deck_b1")).toEqual([KUESSEN]);
  });

  it("reports it again on the next sync while it lasts", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);
    expect(sync("deck_b1", `## ${KUESSEN}\n\nto kiss!\n`).idCollisions).toHaveLength(1);
  });

  it("leaves the same front in two decks a quiet duplicate", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    const result = sync("deck_b1", `## ${PASSEN}\n\nto suit\n`);

    expect(result.idCollisions).toBeUndefined();
    expect(result.duplicatesSkipped).toBe(0);
  });

  it("does not report a stamped card moved and edited between syncs", () => {
    const id = generateFlashcardId("Q");
    const token = `%%dk:h:${encodeAnchorValue("a", [id])}%%`;
    sync("deck_a1", `## Q\n\nA.\n${token}\n`);
    const result = sync("deck_b1", `## Q, reworded\n\nA.\n${token}\n`);

    expect(result.idCollisions).toBeUndefined();
  });

  it("reports an untokened card that collides with another deck's stamped card", () => {
    const id = generateFlashcardId(PASSEN);
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n%%dk:h:${encodeAnchorValue("a", [id])}%%\n`);
    const result = sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);

    expect(result.idCollisions).toEqual([{ id, fronts: [PASSEN, KUESSEN] }]);
  });

  it("does not fold an edited card's history into the card that holds its new id", () => {
    const passenId = generateFlashcardId(PASSEN);
    const typoId = generateFlashcardId("küsen (küsst · hat geküsst)");
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    sync("deck_b1", "## küsen (küsst · hat geküsst)\n\nto kiss\n");
    addReview(passenId, "2026-10-01T00:00:00.000Z");
    addReview(typoId, "2026-10-02T00:00:00.000Z");

    // Same back, new front: rename detection would pair it with the typo's row.
    const result = sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);

    expect(result.idCollisions).toEqual([{ id: passenId, fronts: [PASSEN, KUESSEN] }]);
    expect(logCount(passenId)).toBe(1);
    expect(logCount(typoId)).toBe(1);
    expect(fronts("deck_a1")).toEqual([PASSEN]);
  });

  it("still adopts an orphaned row instead of reporting it", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM decks WHERE id = 'deck_a1'");
    db.run("PRAGMA foreign_keys = ON");

    const result = sync("deck_b1", `## ${PASSEN}\n\nto fit\n`);

    expect(result.idCollisions).toBeUndefined();
    expect(fronts("deck_b1")).toEqual([PASSEN]);
  });
});
