import { dpkgFormatVersion } from "../deck-db";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { CREATE_TABLES_SQL } from "../../../database/schemas";
import type { DeckTemplate, ExamSettings } from "../../../database/types";
import { packDpkg, type DpkgMediaInput } from "../archive";
import { packageCards, writeDpkgDeckDb, type DirectoryCardContent, type DirectoryPackageContent } from "../deck-db";
import type { ClosableRawDatabase } from "../import";
import { deriveDirectoryCardId } from "../ids";
import { generateContentHash } from "../../../utils/hash";
import type { DpkgProfile } from "../manifest";

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

export function card(ref: string, ownerId: string, front: string, back: string, extra: Partial<DirectoryCardContent> = {}): DirectoryCardContent {
  return {
    id: deriveDirectoryCardId(ref, ownerId),
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

/** A package with one deck, the shape most tests need. */
export function singleDeck(
  name: string,
  cards: DirectoryCardContent[],
  templates: DeckTemplate[] = [],
  fileTags: string[] = []
): DirectoryPackageContent {
  return { decks: [{ key: "", name, fileTags, cards }], templates };
}

/** Build a package; `exams` sets exam settings by deck key. */
/** The profiles a test package carries, and which deck studies with which. */
export interface PackageProfiles {
  list: DpkgProfile[];
  byDeck: Record<string, string>;
}

/** A carried profile with the shipped defaults, changed where given. */
export function packageProfile(key: string, changes: Partial<DpkgProfile> = {}): DpkgProfile {
  return {
    key,
    newCardsPerDay: null,
    reviewCardsPerDay: null,
    reviewOrder: "due-date",
    learningSteps: "1m",
    relearningSteps: "10m",
    requestRetention: 0.9,
    clozeShowContext: "hidden",
    ttsLang: null,
    ttsRate: null,
    ...changes,
  };
}

/** Build a package for `ref` (`publisher/slug`). */
export async function buildPackage(
  ref: string,
  version: number,
  content: DirectoryPackageContent,
  media: DpkgMediaInput[] = [],
  exams: Record<string, ExamSettings> = {},
  title = content.decks[0].name,
  profiles: PackageProfiles = { list: [], byDeck: {} }
): Promise<Uint8Array> {
  const SQL = await sqlJs();
  const deckDb = new SQL.Database();
  const [publisher, slug] = ref.split("/");
  writeDpkgDeckDb(deckDb, ref, content, "2026-10-01T00:00:00.000Z");
  const bytes = deckDb.export();
  deckDb.close();
  const cards = packageCards(content);
  const { bytes: pkg } = await packDpkg({
    manifest: {
      publisher: { id: publisher, name: "Test publisher" },
      slug,
      version,
      title,
      description: "A test deck",
      language: "en",
      subject: "test",
      tags: [],
      license: "personal-use",
      cardCount: cards.length,
      typeCounts: {},
      createdAt: "2026-10-01T00:00:00.000Z",
      generator: "test",
      decks: content.decks.map((deck) => ({
        key: deck.key,
        title: deck.name,
        cardCount: deck.cards.length,
        exam: exams[deck.key] ?? null,
        profile: profiles.byDeck[deck.key] ?? null,
      })),
      profiles: profiles.list,
    },
    deckDb: bytes,
    formatVersion: dpkgFormatVersion(content),
    cardsJson: JSON.stringify(cards),
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
