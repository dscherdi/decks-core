import type { SqlJsValue } from "./sql-types";

/** One statement that moves rows keyed by a card id from `from` to `to`. */
export interface CardChildStatement {
  /** The SQL, with `guard` appended to the clause that selects `from`'s rows. */
  sql: (guard: string) => string;
  params: (from: string, to: string, now: string) => SqlJsValue[];
}

/** Every row keyed by a card id, in the order a card's id change must move them. */
export const CARD_CHILD_STATEMENTS: readonly CardChildStatement[] = [
  {
    sql: (guard) => `UPDATE review_logs SET flashcard_id = ? WHERE flashcard_id = ?${guard}`,
    params: (from, to) => [to, from],
  },
  {
    sql: (guard) => `UPDATE exam_answers SET flashcard_id = ? WHERE flashcard_id = ?${guard}`,
    params: (from, to) => [to, from],
  },
  {
    sql: (guard) => `UPDATE OR IGNORE custom_deck_cards SET flashcard_id = ? WHERE flashcard_id = ?${guard}`,
    params: (from, to) => [to, from],
  },
  {
    sql: (guard) =>
      `UPDATE OR IGNORE custom_deck_card_tombstones SET flashcard_id = ? WHERE flashcard_id = ?${guard}`,
    params: (from, to) => [to, from],
  },
  {
    sql: (guard) => `DELETE FROM custom_deck_cards WHERE flashcard_id = ?${guard}`,
    params: (from) => [from],
  },
  {
    sql: (guard) => `
      INSERT INTO card_state_overlays (flashcard_id, suspended_at, buried_until, modified)
      SELECT ?, suspended_at, buried_until, modified FROM card_state_overlays WHERE flashcard_id = ?${guard}
      ON CONFLICT(flashcard_id) DO UPDATE SET
        suspended_at = excluded.suspended_at,
        buried_until = excluded.buried_until,
        modified = excluded.modified
      WHERE excluded.modified > card_state_overlays.modified`,
    params: (from, to) => [to, from],
  },
  {
    sql: (guard) => `DELETE FROM card_state_overlays WHERE flashcard_id = ?${guard}`,
    params: (from) => [from],
  },
  {
    // A card the AI workbench wrote keeps its source page when its id changes.
    sql: (guard) => `UPDATE ai_staged_cards SET dedup_hash = ?, modified = ? WHERE dedup_hash = ?${guard}`,
    params: (from, to, now) => [to, now, from],
  },
];
