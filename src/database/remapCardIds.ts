import type { RawDatabase } from "../services/FlashcardSynchronizer";
import {
  generateFlashcardId,
  generateReverseFlashcardId,
  generateClozeFlashcardId,
  generateSpatialFlashcardId,
  generateSpatialClozeFlashcardId,
  generateOcclusionV2FlashcardId,
} from "../utils/hash";
import {
  activeMaskIdForCard,
  occlusionImageName,
  parseOcclusionBack,
} from "../services/occlusion/OcclusionV2";

interface CardIdRow {
  id: string;
  front: string;
  back: string;
  breadcrumb: string;
  clozeText: string | null;
  clozeOrder: number | null;
  edgeId: string | null;
  sourceNodeId: string | null;
}

/**
 * Compute a card's deck-independent ID from its stored fields, branching on the
 * ID prefix (which encodes the card type). Mirrors the synchronizer's ID logic.
 */
function deckIndependentIdForCard(row: CardIdRow): string {
  const nodeId = row.sourceNodeId ?? undefined;
  if (row.id.startsWith("ocard_")) {
    const maskId =
      activeMaskIdForCard({ back: row.back, clozeOrder: row.clozeOrder }) ?? "";
    const imageName = occlusionImageName(parseOcclusionBack(row.back)?.image ?? "");
    return generateOcclusionV2FlashcardId(row.breadcrumb, imageName, maskId);
  }
  if (row.id.startsWith("sccard_")) {
    return generateSpatialClozeFlashcardId(
      row.front,
      row.edgeId ?? "",
      row.clozeText ?? "",
      row.clozeOrder ?? 0
    );
  }
  if (row.id.startsWith("scard_")) {
    return generateSpatialFlashcardId(row.front, row.edgeId ?? "");
  }
  if (row.id.startsWith("rcard_")) {
    // A reverse card's back is the original front the ID is keyed on.
    return generateReverseFlashcardId(row.back, nodeId);
  }
  if (row.id.startsWith("ccard_")) {
    return generateClozeFlashcardId(
      row.front,
      row.clozeText ?? "",
      row.clozeOrder ?? 0,
      nodeId
    );
  }
  return generateFlashcardId(row.front, nodeId);
}

function tableExists(db: RawDatabase, name: string): boolean {
  const stmt = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  );
  stmt.bind([name]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

// Tables that reference a flashcard ID. review_logs is the durable one; the
// custom-deck tables have UNIQUE(custom_deck_id, flashcard_id), so a merge
// (two old IDs → one new ID) needs OR IGNORE to avoid a constraint violation.
const CHILD_TABLES: ReadonlyArray<{ name: string; ignore: boolean }> = [
  { name: "review_logs", ignore: false },
  { name: "custom_deck_cards", ignore: true },
  { name: "custom_deck_card_tombstones", ignore: true },
];

/**
 * One-time migration to deck-independent card IDs. Card IDs used to embed the
 * deck ID, so moving a card between decks (or renaming a deck file) orphaned its
 * review history. This re-points every table that references a flashcard ID from
 * the old deck-scoped ID to the new front-based ID.
 *
 * Must run BEFORE the schema rebuild drops the `flashcards` table, because it
 * reads the old IDs straight off the still-present rows (`oldId = row.id`). The
 * `flashcards` table itself is rebuilt from the vault on the next sync, so it is
 * not updated here — only the durable tables that link to it.
 *
 * Reads via `SELECT *` and probes for each table so it tolerates older schemas
 * that predate some columns/tables. Runs with foreign keys off (child rows
 * temporarily point at IDs not yet in `flashcards`). Idempotent: once IDs are
 * deck-independent, `newId === oldId`.
 *
 * @returns the number of cards whose ID changed.
 */
export function remapCardIdsToDeckIndependent(db: RawDatabase): number {
  if (!tableExists(db, "flashcards")) return 0;

  const rows: CardIdRow[] = [];
  const stmt = db.prepare("SELECT * FROM flashcards");
  while (stmt.step()) {
    // getAsObject returns only the columns that exist, so absent ones (on older
    // schemas) read as undefined and fall back to safe defaults below.
    const r = stmt.getAsObject();
    rows.push({
      id: r.id as string,
      front: (r.front as string) ?? "",
      back: (r.back as string) ?? "",
      breadcrumb: (r.breadcrumb as string) ?? "",
      clozeText: (r.cloze_text as string) ?? null,
      clozeOrder: r.cloze_order == null ? null : Number(r.cloze_order),
      edgeId: (r.edge_id as string) ?? null,
      sourceNodeId: (r.source_node_id as string) ?? null,
    });
  }
  stmt.free();

  const targets = CHILD_TABLES.filter((t) => tableExists(db, t.name));

  // PRAGMA foreign_keys cannot change inside a transaction, so toggle it first.
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN");
  let remapped = 0;
  try {
    for (const row of rows) {
      const newId = deckIndependentIdForCard(row);
      if (newId === row.id) continue;
      for (const t of targets) {
        const verb = t.ignore ? "UPDATE OR IGNORE" : "UPDATE";
        db.run(`${verb} ${t.name} SET flashcard_id = ? WHERE flashcard_id = ?`, [
          newId,
          row.id,
        ]);
      }
      remapped++;
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  return remapped;
}
