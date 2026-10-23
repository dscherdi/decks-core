import type { RawDatabase } from "../services/FlashcardSynchronizer";
import type { NewCardOrder } from "./types";

/** The statements that add the new-card order columns a database lacks; a missing table gets none. */
export function noteOrderColumnStatements(
  flashcardColumns: readonly string[],
  profileColumns: readonly string[]
): string[] {
  const statements: string[] = [];
  if (flashcardColumns.length > 0 && !flashcardColumns.includes("note_position")) {
    statements.push("ALTER TABLE flashcards ADD COLUMN note_position INTEGER");
  }
  if (profileColumns.length > 0 && !profileColumns.includes("new_card_order")) {
    statements.push("ALTER TABLE deckprofiles ADD COLUMN new_card_order TEXT NOT NULL DEFAULT 'created'");
  }
  return statements;
}

function columnsOf(db: RawDatabase, table: string): string[] {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  const names: string[] = [];
  try {
    while (stmt.step()) names.push(String(stmt.get()[1]));
  } finally {
    stmt.free();
  }
  return names;
}

/** Idempotent; for databases created before the new-card order columns existed. */
export function ensureNoteOrderColumns(db: RawDatabase): void {
  for (const sql of noteOrderColumnStatements(columnsOf(db, "flashcards"), columnsOf(db, "deckprofiles"))) {
    db.run(sql);
  }
}

/** Decks studied in note order that hold a card with no position yet: their note is parsed once more. */
export const NOTE_ORDER_PENDING_DECKS_SQL = `
  SELECT d.id, d.filepath FROM decks d
  JOIN deckprofiles p ON p.id = d.profile_id AND p.deleted_at IS NULL
  WHERE p.new_card_order = 'note'
    AND EXISTS (SELECT 1 FROM flashcards f WHERE f.deck_id = d.id AND f.note_position IS NULL)`;

/** The same for one deck; takes the deck id. */
export const NOTE_ORDER_PENDING_DECK_SQL = `${NOTE_ORDER_PENDING_DECKS_SQL} AND d.id = ?`;

/** The ORDER BY for new cards. In note order a group's decks come in `deckIds` order; unplaced cards end each deck, oldest first. */
export function newCardOrderBy(order: NewCardOrder, deckIds: readonly string[] = []): { sql: string; params: string[] } {
  if (order === "random") return { sql: "ORDER BY RANDOM()", params: [] };
  if (order === "created") return { sql: "ORDER BY due_date ASC", params: [] };
  if (deckIds.length < 2) {
    return { sql: "ORDER BY note_position IS NULL, note_position ASC, due_date ASC", params: [] };
  }
  const rank = deckIds.map((_, index) => `WHEN ? THEN ${index}`).join(" ");
  return {
    sql: `ORDER BY CASE deck_id ${rank} ELSE ${deckIds.length} END, note_position IS NULL, note_position ASC, due_date ASC`,
    params: [...deckIds],
  };
}
