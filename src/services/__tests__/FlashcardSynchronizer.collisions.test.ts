import initSqlJs, { type Database } from "sql.js";
import { CREATE_TABLES_SQL } from "../../database/schemas";
import { DEFAULT_DECK_PROFILE, DEFAULT_PROFILE_ID, type DeckProfile } from "../../database/types";
import { generateFlashcardId } from "../../utils/hash";
import { encodeAnchorValue } from "../../utils/anchors";
import { wideContentId } from "../../utils/content-identity";
import { FlashcardSynchronizer, type SyncResult } from "../FlashcardSynchronizer";

const PASSEN = "passen (passt · hat gepasst)";
const KUESSEN = "küssen (küsst · hat geküsst)";
const SHARED = generateFlashcardId(PASSEN);
const WIDE_KUESSEN = wideContentId(SHARED, { front: KUESSEN });
const WIDE_PASSEN = wideContentId(SHARED, { front: PASSEN });
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

function cards(deckId: string): Array<{ id: string; front: string; state: string }> {
  const result = db.exec("SELECT id, front, state FROM flashcards WHERE deck_id = ? ORDER BY front", [deckId]);
  return (result[0]?.values ?? []).map(([id, front, state]) => ({
    id: id as string,
    front: front as string,
    state: state as string,
  }));
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

const token = (id: string): string => `%%dk:h:${encodeAnchorValue("a", [id])}%%`;

describe("id collisions across decks", () => {
  it("hashes the two fronts to one content id", () => {
    expect(generateFlashcardId(KUESSEN)).toBe(SHARED);
    expect(WIDE_KUESSEN).toMatch(/^card_[a-z0-9]{7,13}$/);
    expect(WIDE_KUESSEN).not.toBe(WIDE_PASSEN);
  });

  it("gives a card whose content id another deck's card holds its wide id", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    const result = sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n\n## sehen\n\nto see\n`);

    expect(result.idCollisions).toBeUndefined();
    expect(result.duplicatesSkipped).toBe(0);
    expect(cards("deck_a1").map((c) => c.id)).toEqual([SHARED]);
    expect(cards("deck_b1")).toMatchObject([
      { id: WIDE_KUESSEN, front: KUESSEN },
      { id: generateFlashcardId("sehen"), front: "sehen" },
    ]);
  });

  it("lets the note synced second take the wide id, whichever it is", () => {
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);

    expect(cards("deck_b1").map((c) => c.id)).toEqual([SHARED]);
    expect(cards("deck_a1").map((c) => c.id)).toEqual([WIDE_PASSEN]);
  });

  it("keeps the wide id on later syncs", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);
    addReview(WIDE_KUESSEN, "2026-10-02T00:00:00.000Z");

    const result = sync("deck_b1", `## ${KUESSEN}\n\nto kiss, to give a kiss\n`);

    expect(result.operationsCount).toBe(1);
    expect(cards("deck_b1").map((c) => c.id)).toEqual([WIDE_KUESSEN]);
    expect(logCount(WIDE_KUESSEN)).toBe(1);
  });

  it("leaves the same front in two decks a quiet duplicate", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    const result = sync("deck_b1", `## ${PASSEN}\n\nto suit\n`);

    expect(result.idCollisions).toBeUndefined();
    expect(cards("deck_b1")).toEqual([]);
  });

  it("leaves a stamped card moved and edited between syncs alone", () => {
    const id = generateFlashcardId("Q");
    sync("deck_a1", `## Q\n\nA.\n${token(id)}\n`);
    const result = sync("deck_b1", `## Q, reworded\n\nA.\n${token(id)}\n`);

    expect(result.idCollisions).toBeUndefined();
    expect(cards("deck_a1").map((c) => c.id)).toEqual([id]);
  });

  it("gives an untokened card the wide id when another deck's stamped card holds its id", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n${token(SHARED)}\n`);
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);

    expect(cards("deck_b1").map((c) => c.id)).toEqual([WIDE_KUESSEN]);
  });

  it("lets a token take its id back from an untokened card in another deck", () => {
    // A fresh device: the untokened card synced first and restored the stamped card's history.
    addReview(SHARED, "2026-10-01T00:00:00.000Z");
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);
    expect(cards("deck_b1")).toMatchObject([{ id: SHARED, state: "review" }]);

    sync("deck_a1", `## ${PASSEN}\n\nto fit\n${token(SHARED)}\n`);

    expect(cards("deck_a1")).toMatchObject([{ id: SHARED, front: PASSEN, state: "review" }]);
    expect(cards("deck_b1")).toMatchObject([{ id: WIDE_KUESSEN, front: KUESSEN, state: "new" }]);
    expect(logCount(SHARED)).toBe(1);
    // The holder's next sync finds its wide row and leaves it be.
    expect(sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`).operationsCount).toBe(0);
  });

  it("carries an edited card's history to its wide id, not into the card that holds its content id", () => {
    const typoId = generateFlashcardId("küsen (küsst · hat geküsst)");
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    sync("deck_b1", "## küsen (küsst · hat geküsst)\n\nto kiss\n");
    addReview(SHARED, "2026-10-01T00:00:00.000Z");
    addReview(typoId, "2026-10-02T00:00:00.000Z");

    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);

    expect(logCount(SHARED)).toBe(1);
    expect(logCount(typoId)).toBe(0);
    expect(logCount(WIDE_KUESSEN)).toBe(1);
    expect(cards("deck_a1").map((c) => c.id)).toEqual([SHARED]);
    expect(cards("deck_b1")).toMatchObject([{ id: WIDE_KUESSEN, front: KUESSEN }]);
  });

  it("still adopts an orphaned row of the same card", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM decks WHERE id = 'deck_a1'");
    db.run("PRAGMA foreign_keys = ON");

    sync("deck_b1", `## ${PASSEN}\n\nto fit\n`);

    expect(cards("deck_b1").map((c) => c.id)).toEqual([SHARED]);
  });

  it("does not adopt an orphaned row of a different card", () => {
    sync("deck_a1", `## ${PASSEN}\n\nto fit\n`);
    db.run("UPDATE flashcards SET state = 'review', repetitions = 3 WHERE id = ?", [SHARED]);
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM decks WHERE id = 'deck_a1'");
    db.run("PRAGMA foreign_keys = ON");

    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n`);

    expect(cards("deck_b1")).toMatchObject([{ id: WIDE_KUESSEN, state: "new" }]);
  });
});

describe("id collisions within a note", () => {
  it("studies both cards, the second under its wide id", () => {
    const result = sync("deck_b1", `## ${PASSEN}\n\nto fit\n\n## ${KUESSEN}\n\nto kiss\n`);

    expect(result.idCollisions).toBeUndefined();
    expect(cards("deck_b1").map((c) => c.id)).toEqual([WIDE_KUESSEN, SHARED]);
  });

  it("keeps each card's id when the two swap places", () => {
    sync("deck_b1", `## ${PASSEN}\n\nto fit\n\n## ${KUESSEN}\n\nto kiss\n`);
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n\n## ${PASSEN}\n\nto fit\n`);

    expect(cards("deck_b1").map((c) => c.id)).toEqual([WIDE_KUESSEN, SHARED]);
  });

  it("gives the id to the card whose token carries it, wherever it stands", () => {
    sync("deck_b1", `## ${KUESSEN}\n\nto kiss\n\n## ${PASSEN}\n\nto fit\n${token(SHARED)}\n`);

    expect(cards("deck_b1").map((c) => c.id)).toEqual([WIDE_KUESSEN, SHARED]);
  });
});
