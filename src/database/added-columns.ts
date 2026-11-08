import type { RawDatabase } from "../services/FlashcardSynchronizer";
import { columnsOf, noteOrderColumnStatements } from "./note-order";

/** Every column added by idempotent ALTER instead of a schema bump that a database lacks; a missing table gets none. */
export function addedColumnStatements(
  flashcardColumns: readonly string[],
  profileColumns: readonly string[]
): string[] {
  const statements = noteOrderColumnStatements(flashcardColumns, profileColumns);
  if (profileColumns.length > 0 && !profileColumns.includes("cloze_group_by_line")) {
    statements.push("ALTER TABLE deckprofiles ADD COLUMN cloze_group_by_line INTEGER NOT NULL DEFAULT 0");
  }
  return statements;
}

/** Idempotent; for databases created before these columns existed. */
export function ensureAddedColumns(db: RawDatabase): void {
  for (const sql of addedColumnStatements(columnsOf(db, "flashcards"), columnsOf(db, "deckprofiles"))) {
    db.run(sql);
  }
}
