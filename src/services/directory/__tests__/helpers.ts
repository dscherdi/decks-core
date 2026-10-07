import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { CREATE_TABLES_SQL } from "../../../database/schemas";
import { packDpkg, type DpkgMediaInput } from "../archive";
import { writeDpkgDeckDb, type DirectoryCardContent, type DirectoryDeckContent } from "../deck-db";
import type { ClosableRawDatabase } from "../import";
import { deriveDirectoryCardId } from "../ids";
import { generateContentHash } from "../../../utils/hash";

let sql: SqlJsStatic | null = null;

export async function sqlJs(): Promise<SqlJsStatic> {
  if (!sql) sql = await initSqlJs();
  return sql;
}

/** A user's main database, as a fresh install creates it. */
export async function mainDb(): Promise<Database> {
  const SQL = await sqlJs();
  const db = new SQL.Database();
  db.run(CREATE_TABLES_SQL);
  return db;
}

export async function opener(): Promise<(bytes: Uint8Array) => ClosableRawDatabase> {
  const SQL = await sqlJs();
  return (bytes) => new SQL.Database(bytes);
}

export function card(slug: string, ownerId: string, front: string, back: string, extra: Partial<DirectoryCardContent> = {}): DirectoryCardContent {
  return {
    id: deriveDirectoryCardId(slug, ownerId),
    position: 0,
    type: "header-paragraph",
    front,
    back,
    notes: "",
    breadcrumb: "",
    clozeText: null,
    clozeOrder: null,
    hint: "",
    tags: [],
    templateRow: null,
    contentHash: generateContentHash(back),
    ...extra,
  };
}

export async function buildPackage(
  slug: string,
  version: number,
  content: DirectoryDeckContent,
  media: DpkgMediaInput[] = []
): Promise<Uint8Array> {
  const SQL = await sqlJs();
  const deckDb = new SQL.Database();
  writeDpkgDeckDb(deckDb, slug, content, "2026-10-01T00:00:00.000Z");
  const bytes = deckDb.export();
  deckDb.close();
  const { bytes: pkg } = await packDpkg({
    manifest: {
      slug,
      version,
      title: content.name,
      description: "A test deck",
      language: "en",
      subject: "test",
      tags: [],
      license: "personal-use",
      cardCount: content.cards.length,
      typeCounts: {},
      createdAt: "2026-10-01T00:00:00.000Z",
      generator: "test",
    },
    deckDb: bytes,
    cardsJson: JSON.stringify(content.cards),
    media,
  });
  return pkg;
}

export function rows(db: Database, sql: string, params: (string | number | null)[] = []): Record<string, string | number | null>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out: Record<string, string | number | null>[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const clean: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) {
      clean[key] = value instanceof Uint8Array ? null : value;
    }
    out.push(clean);
  }
  stmt.free();
  return out;
}

/** Record a review the way the scheduler does, so restores have a log to read. */
export function review(db: Database, cardId: string, reviewedAt: string, stability: number): void {
  db.run(
    `INSERT INTO review_logs (id, flashcard_id, last_reviewed_at, reviewed_at, rating, rating_label,
       old_state, new_state, new_repetitions, new_stability, new_difficulty,
       old_interval_minutes, new_interval_minutes, old_due_at, new_due_at, elapsed_days, retrievability,
       request_retention, maximum_interval_days, min_minutes, fsrs_weights_version, scheduler_version)
     VALUES (?, ?, ?, ?, 3, 'good', 'new', 'review', 1, ?, 5.0, 0, 1440, ?, ?, 0, 1, 0.9, 36500, 1, 'v', 'v')`,
    [`log_${cardId}_${reviewedAt}`, cardId, reviewedAt, reviewedAt, stability, reviewedAt, reviewedAt]
  );
  db.run(
    `UPDATE flashcards SET state = 'review', stability = ?, repetitions = 1, interval = 1440,
       last_reviewed = ?, modified = ? WHERE id = ?`,
    [stability, reviewedAt, reviewedAt, cardId]
  );
}
