import { DIRECTORY_TABLES_SQL } from "../../database/schemas";
import type { SqlJsValue } from "../../database/sql-types";
import { DEFAULT_PROFILE_ID, EXAMS_PROFILE_ID, type DeckTemplate, type ProfileTagMapping } from "../../database/types";
import { pickProfileMapping } from "../../utils/deck-tags";
import { isJsonObject, isStringList, parseJson } from "../../utils/json";
import type { ParsedFlashcard } from "../FlashcardParser";
import { FlashcardSynchronizer, type RawDatabase, type SyncResult } from "../FlashcardSynchronizer";
import {
  cardContentFromRow,
  packageCards,
  parseStringList,
  templateFromRow,
  type DirectoryCardContent,
  type DirectoryPackageContent,
} from "./deck-db";
import { DIRECTORY_PATH_PREFIX, directoryDeckId, directoryDeckPath, directoryDeckTag } from "./ids";
import { DpkgError, examDeckKeys, parseDpkgManifest, type DpkgManifest } from "./manifest";

export interface DirectoryDeckRecord {
  id: string;
  slug: string;
  version: number;
  title: string;
  description: string;
  manifestJson: string;
  archiveSha256: string;
  /** Each deck's note tags, by deck key. */
  fileTagsByKey: Record<string, string[]>;
  importedAt: string;
  modified: string;
  removedAt: string | null;
}

type Row = Record<string, SqlJsValue>;

function query(db: RawDatabase, sql: string, params: SqlJsValue[] = []): Row[] {
  const stmt = db.prepare(sql);
  const out: Row[] = [];
  try {
    if (params.length > 0) stmt.bind(params);
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

function scalar(db: RawDatabase, sql: string, params: SqlJsValue[] = []): SqlJsValue | undefined {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    return stmt.step() ? stmt.get()[0] : undefined;
  } finally {
    stmt.free();
  }
}

function hasTable(db: RawDatabase, name: string): boolean {
  return scalar(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !== undefined;
}

function parseFileTagsByKey(raw: string | null): Record<string, string[]> {
  const parsed = raw ? parseJson(raw) : null;
  // A single deck's tags were once stored as a plain list.
  if (Array.isArray(parsed)) return { "": parseStringList(raw) };
  if (!isJsonObject(parsed)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isStringList(value)) out[key] = value;
  }
  return out;
}

export function directoryDeckFromRow(row: Row): DirectoryDeckRecord {
  const text = (key: string): string => (typeof row[key] === "string" ? String(row[key]) : "");
  const removed = row.removed_at;
  return {
    id: text("id"),
    slug: text("slug"),
    version: typeof row.version === "number" ? row.version : 0,
    title: text("title"),
    description: text("description"),
    manifestJson: text("manifest"),
    archiveSha256: text("archive_sha256"),
    fileTagsByKey: parseFileTagsByKey(typeof row.file_tags === "string" ? row.file_tags : null),
    importedAt: text("imported_at"),
    modified: text("modified"),
    removedAt: typeof removed === "string" ? removed : null,
  };
}

/** Idempotent; for databases created before the directory tables, or a column of them, existed. */
export function ensureDirectoryTables(db: RawDatabase): void {
  db.run(DIRECTORY_TABLES_SQL);
  if (!columnsOf(db, "directory_cards").includes("deck_key")) {
    db.run("ALTER TABLE directory_cards ADD COLUMN deck_key TEXT NOT NULL DEFAULT ''");
  }
}

export function listDirectoryDecks(db: RawDatabase, includeRemoved = false): DirectoryDeckRecord[] {
  if (!hasTable(db, "directory_decks")) return [];
  const where = includeRemoved ? "" : "WHERE removed_at IS NULL";
  return query(db, `SELECT * FROM directory_decks ${where} ORDER BY title COLLATE NOCASE`).map(directoryDeckFromRow);
}

export function getDirectoryDeck(db: RawDatabase, deckId: string): DirectoryDeckRecord | null {
  if (!hasTable(db, "directory_decks")) return null;
  const row = query(db, "SELECT * FROM directory_decks WHERE id = ?", [deckId])[0];
  return row ? directoryDeckFromRow(row) : null;
}

/** A package's stored cards: all of them, or one deck's. */
export function loadDirectoryCards(db: RawDatabase, packageId: string, key?: string): DirectoryCardContent[] {
  const rows =
    key === undefined
      ? query(db, "SELECT * FROM directory_cards WHERE directory_deck_id = ? ORDER BY position", [packageId])
      : query(db, "SELECT * FROM directory_cards WHERE directory_deck_id = ? AND deck_key = ? ORDER BY position", [
          packageId,
          key,
        ]);
  return rows.map((row, index) => cardContentFromRow(row, index));
}

export interface DirectoryPackageDeck {
  key: string;
  title: string;
  exam: boolean;
}

/** The decks an installed package holds, as its manifest lists them. */
export function directoryPackageDecks(db: RawDatabase, record: DirectoryDeckRecord): DirectoryPackageDeck[] {
  const exams = examDeckKeys(record.manifestJson);
  try {
    return parseDpkgManifest(record.manifestJson).decks.map((deck) => ({
      key: deck.key,
      title: deck.key === "" ? record.title : deck.title,
      exam: exams.has(deck.key),
    }));
  } catch {
    // A manifest this build cannot read still names its decks through the stored cards.
    const keys = query(db, "SELECT DISTINCT deck_key FROM directory_cards WHERE directory_deck_id = ? ORDER BY deck_key", [
      record.id,
    ]).map((row) => String(row.deck_key ?? ""));
    return keys.map((key) => ({ key, title: key === "" ? record.title : `${record.title} › ${key}`, exam: exams.has(key) }));
  }
}

/** Working deck ids of an installed package, whichever of its decks they are. */
export function packageDeckIds(db: RawDatabase, slug: string): string[] {
  const root = directoryDeckPath(slug);
  return query(db, "SELECT id FROM decks WHERE filepath = ? OR filepath LIKE ?", [root, `${root}/%`]).map((row) =>
    String(row.id)
  );
}

/** A directory deck's own templates; they never bind to cards outside it. */
export function loadDirectoryTemplates(db: RawDatabase, deckId: string): DeckTemplate[] {
  if (!hasTable(db, "directory_templates")) return [];
  return query(db, "SELECT * FROM directory_templates WHERE directory_deck_id = ? ORDER BY rowid", [deckId]).map(
    directoryTemplateFromRow
  );
}

export function directoryTemplateFromRow(row: Row): DeckTemplate {
  return { ...templateFromRow(row), sourceFile: String(row.directory_deck_id ?? "") };
}

export const SELECT_DIRECTORY_DECKS_SQL = "SELECT * FROM directory_decks WHERE removed_at IS NULL ORDER BY title COLLATE NOCASE";
export const SELECT_DIRECTORY_TEMPLATES_SQL = "SELECT * FROM directory_templates WHERE directory_deck_id = ? ORDER BY rowid";
export const TOMBSTONE_DIRECTORY_DECK_SQL =
  "UPDATE directory_decks SET removed_at = ?, modified = ? WHERE id = ? AND removed_at IS NULL AND modified < ?";

export interface StoreDirectoryDeckInput {
  manifest: DpkgManifest;
  content: DirectoryPackageContent;
  archiveSha256: string;
  now: string;
}

/** Save a package's content, replacing any earlier version of the same deck. */
export function storeDirectoryDeck(
  db: RawDatabase,
  input: StoreDirectoryDeckInput
): { deckId: string; previous: DirectoryDeckRecord | null } {
  const { manifest, content, archiveSha256, now } = input;
  if (packageCards(content).length === 0) throw new DpkgError("invalid_deck", "The package holds no cards");
  ensureDirectoryTables(db);
  const deckId = directoryDeckId(manifest.slug);
  const previous = getDirectoryDeck(db, deckId);

  db.run("SAVEPOINT directory_store");
  try {
    db.run(
      `INSERT INTO directory_decks (id, slug, version, title, description, manifest, archive_sha256,
         file_tags, imported_at, modified, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug, version = excluded.version, title = excluded.title,
         description = excluded.description, manifest = excluded.manifest,
         archive_sha256 = excluded.archive_sha256, file_tags = excluded.file_tags,
         imported_at = excluded.imported_at, modified = excluded.modified, removed_at = NULL`,
      [
        deckId,
        manifest.slug,
        manifest.version,
        manifest.title,
        manifest.description,
        JSON.stringify(manifest),
        archiveSha256,
        JSON.stringify(Object.fromEntries(content.decks.map((deck) => [deck.key, deck.fileTags]))),
        now,
        now,
      ]
    );
    writeContent(db, deckId, content, now);
    db.run("RELEASE directory_store");
  } catch (error) {
    db.run("ROLLBACK TO directory_store");
    db.run("RELEASE directory_store");
    throw error;
  }
  return { deckId, previous };
}

function writeContent(db: RawDatabase, deckId: string, content: DirectoryPackageContent, now: string): void {
  db.run("DELETE FROM directory_cards WHERE directory_deck_id = ?", [deckId]);
  db.run("DELETE FROM directory_templates WHERE directory_deck_id = ?", [deckId]);
  const insertCard = db.prepare(
    `INSERT OR REPLACE INTO directory_cards (id, directory_deck_id, deck_key, position, type, front, back, notes, breadcrumb,
       cloze_text, cloze_order, hint, tags, template_row, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const cards = content.decks.flatMap((deck) => deck.cards.map((card) => ({ card, key: deck.key })));
  try {
    cards.forEach(({ card, key }, index) => {
      insertCard.run([
        card.id,
        deckId,
        key,
        index,
        card.type,
        card.front,
        card.back,
        card.notes,
        card.breadcrumb,
        card.clozeText,
        card.clozeOrder,
        card.hint,
        card.tags.join(","),
        card.templateRow ? JSON.stringify(card.templateRow) : null,
        card.contentHash,
      ]);
    });
  } finally {
    insertCard.free();
  }
  const insertTemplate = db.prepare(
    `INSERT OR REPLACE INTO directory_templates (id, directory_deck_id, tags, front_template, front_type,
       back_template, back_type, notes_template, notes_type, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    for (const template of content.templates) {
      insertTemplate.run([
        `${deckId}:${template.id}`,
        deckId,
        JSON.stringify(template.tags),
        template.frontTemplate,
        template.frontType,
        template.backTemplate,
        template.backType,
        template.notesTemplate,
        template.notesType,
        now,
        now,
      ]);
    }
  } finally {
    insertTemplate.free();
  }
}

function liveProfile(db: RawDatabase, id: string): boolean {
  return scalar(db, "SELECT 1 FROM deckprofiles WHERE id = ? AND deleted_at IS NULL", [id]) !== undefined;
}

/**
 * The profile one deck of a package studies with: a `#directory` tag mapping,
 * else the Exams preset for an exam deck, else the default.
 */
export function resolveDirectoryProfileId(
  db: RawDatabase,
  record: Pick<DirectoryDeckRecord, "slug" | "manifestJson">,
  key = ""
): string {
  const mappings: ProfileTagMapping[] = query(
    db,
    "SELECT id, profile_id, tag, created FROM profile_tag_mappings WHERE deleted_at IS NULL"
  ).map((row) => ({
    id: String(row.id ?? ""),
    profileId: String(row.profile_id ?? ""),
    tag: String(row.tag ?? ""),
    created: String(row.created ?? ""),
  }));
  const mapped = pickProfileMapping(mappings, [directoryDeckTag(record.slug, key)]);
  if (mapped && liveProfile(db, mapped)) return mapped;
  if (examDeckKeys(record.manifestJson).has(key) && liveProfile(db, EXAMS_PROFILE_ID)) return EXAMS_PROFILE_ID;
  return DEFAULT_PROFILE_ID;
}

/** Marker stored in the per-device `last_synced_mtime` once a version is materialised. */
function materialiseMarker(record: DirectoryDeckRecord): number {
  const parsed = Date.parse(record.modified);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function storedCount(db: RawDatabase, record: DirectoryDeckRecord, key: string): SqlJsValue | undefined {
  return scalar(db, "SELECT COUNT(*) FROM directory_cards WHERE directory_deck_id = ? AND deck_key = ?", [record.id, key]);
}

function workingCount(db: RawDatabase, deckId: string): SqlJsValue | undefined {
  return scalar(db, "SELECT COUNT(*) FROM flashcards WHERE deck_id = ?", [deckId]);
}

export function needsMaterialise(db: RawDatabase, record: DirectoryDeckRecord): boolean {
  const decks = directoryPackageDecks(db, record);
  const ids = new Set(decks.map((deck) => directoryDeckId(record.slug, deck.key)));
  if (packageDeckIds(db, record.slug).some((id) => !ids.has(id))) return true;
  return decks.some((deck) => {
    const id = directoryDeckId(record.slug, deck.key);
    const marker = scalar(db, "SELECT last_synced_mtime FROM decks WHERE id = ?", [id]);
    if (marker === undefined || marker !== materialiseMarker(record)) return true;
    return workingCount(db, id) !== storedCount(db, record, deck.key);
  });
}

function toParsed(card: DirectoryCardContent): ParsedFlashcard {
  return {
    front: card.front,
    back: card.back,
    notes: card.notes,
    type: card.type,
    breadcrumb: card.breadcrumb,
    tags: card.tags,
    isReverse: card.id.startsWith("rcard_"),
    clozeText: card.clozeText ?? undefined,
    clozeOrder: card.clozeOrder ?? undefined,
    hint: card.hint,
    templateRow: card.templateRow ?? undefined,
    fixedId: card.id,
    fixedContentHash: card.contentHash,
  };
}

function materialiseOne(db: RawDatabase, record: DirectoryDeckRecord, deck: DirectoryPackageDeck, now: string): SyncResult {
  const id = directoryDeckId(record.slug, deck.key);
  const path = directoryDeckPath(record.slug, deck.key);
  const tag = directoryDeckTag(record.slug, deck.key);
  const fileTags = JSON.stringify(record.fileTagsByKey[deck.key] ?? []);
  if (scalar(db, "SELECT 1 FROM decks WHERE id = ?", [id]) === undefined) {
    db.run(
      `INSERT INTO decks (id, name, filepath, tag, last_reviewed, profile_id, created, modified, last_synced_mtime, file_tags)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)`,
      [id, deck.title, path, tag, resolveDirectoryProfileId(db, record, deck.key), now, now, fileTags]
    );
  } else {
    db.run("UPDATE decks SET name = ?, filepath = ?, tag = ?, file_tags = ? WHERE id = ?", [
      deck.title,
      path,
      tag,
      fileTags,
      id,
    ]);
  }

  const result = new FlashcardSynchronizer(db).syncFlashcardsForDeck({
    deckId: id,
    deckName: deck.title,
    deckFilepath: path,
    fileContent: "",
    preParsed: loadDirectoryCards(db, record.id, deck.key).map(toParsed),
    reverseCards: false,
    refuseEmptyResult: true,
  });
  if (!result.skippedEmptyParse) {
    db.run("UPDATE decks SET last_synced_mtime = ? WHERE id = ?", [materialiseMarker(record), id]);
  }
  return result;
}

/**
 * Build the working decks and card rows of a package from its stored content.
 * Scheduling of cards that already exist is kept; returning cards restore from review_logs.
 */
export function materialiseDirectoryDeck(db: RawDatabase, record: DirectoryDeckRecord, now: string): SyncResult[] {
  const decks = directoryPackageDecks(db, record);
  const keep = new Set(decks.map((deck) => directoryDeckId(record.slug, deck.key)));
  for (const stale of packageDeckIds(db, record.slug)) if (!keep.has(stale)) dropMaterialisedDeck(db, stale);
  const results = decks.map((deck) => materialiseOne(db, record, deck, now));
  // A card that moved between two of the package's decks is only free once its old deck let it go.
  decks.forEach((deck, index) => {
    if (workingCount(db, directoryDeckId(record.slug, deck.key)) !== storedCount(db, record, deck.key)) {
      results[index] = materialiseOne(db, record, deck, now);
    }
  });
  return results;
}

/** Each takes the deck id. Review history is kept, so a re-import restores progress. */
export const DROP_MATERIALISED_DECK_SQL: readonly string[] = [
  "DELETE FROM custom_deck_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id = ?)",
  "DELETE FROM cram_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id = ?)",
  "DELETE FROM flashcards WHERE deck_id = ?",
  "DELETE FROM decks WHERE id = ?",
];

// The working decks of the package whose id is bound; its row outlives removal as a tombstone.
const PACKAGE_DECKS = `SELECT d.id FROM decks d JOIN directory_decks p
  ON d.filepath = '${DIRECTORY_PATH_PREFIX}' || p.slug OR d.filepath LIKE '${DIRECTORY_PATH_PREFIX}' || p.slug || '/%'
  WHERE p.id = ?`;

/** Each takes the package id: a removed package's stored content, then every one of its working decks. */
export const REMOVE_DIRECTORY_CONTENT_SQL: readonly string[] = [
  "DELETE FROM directory_cards WHERE directory_deck_id = ?",
  "DELETE FROM directory_templates WHERE directory_deck_id = ?",
  `DELETE FROM custom_deck_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id IN (${PACKAGE_DECKS}))`,
  `DELETE FROM cram_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id IN (${PACKAGE_DECKS}))`,
  `DELETE FROM flashcards WHERE deck_id IN (${PACKAGE_DECKS})`,
  `DELETE FROM decks WHERE id IN (${PACKAGE_DECKS})`,
];

export function dropMaterialisedDeck(db: RawDatabase, deckId: string): void {
  for (const sql of DROP_MATERIALISED_DECK_SQL) db.run(sql, [deckId]);
}

export interface MaterialiseAllResult {
  materialised: string[];
  dropped: string[];
  /** Decks whose profile followed a changed `#directory` tag mapping. */
  reprofiled: string[];
}

/**
 * Bring every directory deck's working rows in line with the stored content:
 * after a migration, a merge, an import or a removal on another device.
 */
export function materialiseDirectoryDecks(db: RawDatabase, now: string): MaterialiseAllResult {
  const out: MaterialiseAllResult = { materialised: [], dropped: [], reprofiled: [] };
  if (hasTable(db, "directory_decks")) ensureDirectoryTables(db);
  for (const record of listDirectoryDecks(db, true)) {
    if (record.removedAt !== null) {
      for (const id of packageDeckIds(db, record.slug)) {
        dropMaterialisedDeck(db, id);
        out.dropped.push(id);
      }
      continue;
    }
    if (needsMaterialise(db, record)) {
      materialiseDirectoryDeck(db, record, now);
      out.materialised.push(record.id);
    }
    for (const deck of directoryPackageDecks(db, record)) {
      const id = directoryDeckId(record.slug, deck.key);
      const profileId = resolveDirectoryProfileId(db, record, deck.key);
      if (scalar(db, "SELECT profile_id FROM decks WHERE id = ?", [id]) !== profileId) {
        db.run("UPDATE decks SET profile_id = ? WHERE id = ?", [profileId, id]);
        out.reprofiled.push(id);
      }
    }
  }
  return out;
}

/**
 * Remove a directory deck as of `at`. A tombstone stays so merges never bring
 * it back; an older removal never overrides a newer import.
 */
export function removeDirectoryDeck(db: RawDatabase, deckId: string, at: string): boolean {
  if (!hasTable(db, "directory_decks")) return false;
  const current = getDirectoryDeck(db, deckId);
  if (!current || current.removedAt !== null || current.modified >= at) return false;
  db.run("UPDATE directory_decks SET removed_at = ?, modified = ? WHERE id = ?", [at, at, deckId]);
  for (const sql of REMOVE_DIRECTORY_CONTENT_SQL) db.run(sql, [deckId]);
  return true;
}

function columnsOf(db: RawDatabase, table: string): string[] {
  return query(db, `PRAGMA table_info(${table})`).map((row) => String(row.name));
}

function copyRows(remote: RawDatabase, local: RawDatabase, table: string, deckId: string): void {
  const localColumns = new Set(columnsOf(local, table));
  const columns = columnsOf(remote, table).filter((column) => localColumns.has(column));
  const insert = local.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  );
  try {
    for (const row of query(remote, `SELECT * FROM ${table} WHERE directory_deck_id = ?`, [deckId])) {
      insert.run(columns.map((column) => row[column] ?? null));
    }
  } finally {
    insert.free();
  }
}

/**
 * Merge another copy's directory tables: a newer deck row wins with all its content.
 * Returns the ids taken from `remote`; follow with `materialiseDirectoryDecks`.
 */
export function mergeDirectoryTables(local: RawDatabase, remote: RawDatabase): string[] {
  if (!hasTable(remote, "directory_decks")) return [];
  ensureDirectoryTables(local);
  const taken: string[] = [];
  const deckColumns = columnsOf(local, "directory_decks");
  const remoteDeckColumns = new Set(columnsOf(remote, "directory_decks"));
  const shared = deckColumns.filter((column) => remoteDeckColumns.has(column));
  for (const row of query(remote, "SELECT * FROM directory_decks")) {
    const id = String(row.id ?? "");
    const modified = String(row.modified ?? "");
    const localModified = scalar(local, "SELECT modified FROM directory_decks WHERE id = ?", [id]);
    if (typeof localModified === "string" && localModified >= modified) continue;
    local.run(
      `INSERT OR REPLACE INTO directory_decks (${shared.join(", ")}) VALUES (${shared.map(() => "?").join(", ")})`,
      shared.map((column) => row[column] ?? null)
    );
    local.run("DELETE FROM directory_cards WHERE directory_deck_id = ?", [id]);
    local.run("DELETE FROM directory_templates WHERE directory_deck_id = ?", [id]);
    if (hasTable(remote, "directory_cards")) copyRows(remote, local, "directory_cards", id);
    if (hasTable(remote, "directory_templates")) copyRows(remote, local, "directory_templates", id);
    taken.push(id);
  }
  return taken;
}
