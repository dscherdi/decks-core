import { DIRECTORY_TABLES_SQL } from "../../database/schemas";
import type { SqlJsValue } from "../../database/sql-types";
import { DEFAULT_PROFILE_ID, type DeckTemplate, type ProfileTagMapping } from "../../database/types";
import { pickProfileMapping } from "../../utils/deck-tags";
import type { ParsedFlashcard } from "../FlashcardParser";
import { FlashcardSynchronizer, type RawDatabase, type SyncResult } from "../FlashcardSynchronizer";
import {
  cardContentFromRow,
  parseStringList,
  templateFromRow,
  type DirectoryCardContent,
  type DirectoryDeckContent,
} from "./deck-db";
import { directoryDeckId, directoryDeckPath, directoryDeckTag } from "./ids";
import { DpkgError, type DpkgManifest } from "./manifest";

export interface DirectoryDeckRecord {
  id: string;
  slug: string;
  version: number;
  title: string;
  description: string;
  manifestJson: string;
  archiveSha256: string;
  fileTags: string[];
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
    fileTags: parseStringList(typeof row.file_tags === "string" ? row.file_tags : null),
    importedAt: text("imported_at"),
    modified: text("modified"),
    removedAt: typeof removed === "string" ? removed : null,
  };
}

/** Idempotent; for databases created before the directory tables existed. */
export function ensureDirectoryTables(db: RawDatabase): void {
  db.run(DIRECTORY_TABLES_SQL);
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

export function loadDirectoryCards(db: RawDatabase, deckId: string): DirectoryCardContent[] {
  return query(db, "SELECT * FROM directory_cards WHERE directory_deck_id = ? ORDER BY position", [deckId]).map(
    (row, index) => cardContentFromRow(row, index)
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
  content: DirectoryDeckContent;
  archiveSha256: string;
  now: string;
}

/** Save a package's content, replacing any earlier version of the same deck. */
export function storeDirectoryDeck(
  db: RawDatabase,
  input: StoreDirectoryDeckInput
): { deckId: string; previous: DirectoryDeckRecord | null } {
  const { manifest, content, archiveSha256, now } = input;
  if (content.cards.length === 0) throw new DpkgError("invalid_deck", "The package holds no cards");
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
        JSON.stringify(content.fileTags),
        now,
        now,
      ]
    );
    writeContent(db, deckId, content.cards, content.templates, now);
    db.run("RELEASE directory_store");
  } catch (error) {
    db.run("ROLLBACK TO directory_store");
    db.run("RELEASE directory_store");
    throw error;
  }
  return { deckId, previous };
}

function writeContent(
  db: RawDatabase,
  deckId: string,
  cards: DirectoryCardContent[],
  templates: DeckTemplate[],
  now: string
): void {
  db.run("DELETE FROM directory_cards WHERE directory_deck_id = ?", [deckId]);
  db.run("DELETE FROM directory_templates WHERE directory_deck_id = ?", [deckId]);
  const insertCard = db.prepare(
    `INSERT OR REPLACE INTO directory_cards (id, directory_deck_id, position, type, front, back, notes, breadcrumb,
       cloze_text, cloze_order, hint, tags, template_row, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    cards.forEach((card, index) => {
      insertCard.run([
        card.id,
        deckId,
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
    for (const template of templates) {
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

/** The profile a directory deck studies with: a `#directory` tag mapping, else the default. */
export function resolveDirectoryProfileId(db: RawDatabase, slug: string): string {
  const mappings: ProfileTagMapping[] = query(
    db,
    "SELECT id, profile_id, tag, created FROM profile_tag_mappings WHERE deleted_at IS NULL"
  ).map((row) => ({
    id: String(row.id ?? ""),
    profileId: String(row.profile_id ?? ""),
    tag: String(row.tag ?? ""),
    created: String(row.created ?? ""),
  }));
  const mapped = pickProfileMapping(mappings, [directoryDeckTag(slug)]);
  if (mapped && scalar(db, "SELECT 1 FROM deckprofiles WHERE id = ? AND deleted_at IS NULL", [mapped]) !== undefined) {
    return mapped;
  }
  return DEFAULT_PROFILE_ID;
}

/** Marker stored in the per-device `last_synced_mtime` once a version is materialised. */
function materialiseMarker(record: DirectoryDeckRecord): number {
  const parsed = Date.parse(record.modified);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function needsMaterialise(db: RawDatabase, record: DirectoryDeckRecord): boolean {
  const marker = scalar(db, "SELECT last_synced_mtime FROM decks WHERE id = ?", [record.id]);
  if (marker === undefined || marker !== materialiseMarker(record)) return true;
  const working = scalar(db, "SELECT COUNT(*) FROM flashcards WHERE deck_id = ?", [record.id]);
  const stored = scalar(db, "SELECT COUNT(*) FROM directory_cards WHERE directory_deck_id = ?", [record.id]);
  return working !== stored;
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

/**
 * Build the working deck and card rows from the stored content. Scheduling of
 * cards that already exist is kept; returning cards restore from review_logs.
 */
export function materialiseDirectoryDeck(db: RawDatabase, record: DirectoryDeckRecord, now: string): SyncResult {
  const path = directoryDeckPath(record.slug);
  const tag = directoryDeckTag(record.slug);
  const fileTags = JSON.stringify(record.fileTags);
  if (scalar(db, "SELECT 1 FROM decks WHERE id = ?", [record.id]) === undefined) {
    db.run(
      `INSERT INTO decks (id, name, filepath, tag, last_reviewed, profile_id, created, modified, last_synced_mtime, file_tags)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)`,
      [record.id, record.title, path, tag, resolveDirectoryProfileId(db, record.slug), now, now, fileTags]
    );
  } else {
    db.run("UPDATE decks SET name = ?, filepath = ?, tag = ?, file_tags = ? WHERE id = ?", [
      record.title,
      path,
      tag,
      fileTags,
      record.id,
    ]);
  }

  const result = new FlashcardSynchronizer(db).syncFlashcardsForDeck({
    deckId: record.id,
    deckName: record.title,
    deckFilepath: path,
    fileContent: "",
    preParsed: loadDirectoryCards(db, record.id).map(toParsed),
    reverseCards: false,
    refuseEmptyResult: true,
  });
  if (!result.skippedEmptyParse) {
    db.run("UPDATE decks SET last_synced_mtime = ? WHERE id = ?", [materialiseMarker(record), record.id]);
  }
  return result;
}

/** Each takes the deck id. Review history is kept, so a re-import restores progress. */
export const DROP_MATERIALISED_DECK_SQL: readonly string[] = [
  "DELETE FROM custom_deck_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id = ?)",
  "DELETE FROM cram_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id = ?)",
  "DELETE FROM flashcards WHERE deck_id = ?",
  "DELETE FROM decks WHERE id = ?",
];

/** Each takes the deck id: a removed deck's stored content, then its working rows. */
export const REMOVE_DIRECTORY_CONTENT_SQL: readonly string[] = [
  "DELETE FROM directory_cards WHERE directory_deck_id = ?",
  "DELETE FROM directory_templates WHERE directory_deck_id = ?",
  ...DROP_MATERIALISED_DECK_SQL,
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
  for (const record of listDirectoryDecks(db, true)) {
    if (record.removedAt !== null) {
      if (scalar(db, "SELECT 1 FROM decks WHERE id = ?", [record.id]) !== undefined) {
        dropMaterialisedDeck(db, record.id);
        out.dropped.push(record.id);
      }
      continue;
    }
    if (needsMaterialise(db, record)) {
      materialiseDirectoryDeck(db, record, now);
      out.materialised.push(record.id);
    }
    const profileId = resolveDirectoryProfileId(db, record.slug);
    if (scalar(db, "SELECT profile_id FROM decks WHERE id = ?", [record.id]) !== profileId) {
      db.run("UPDATE decks SET profile_id = ? WHERE id = ?", [profileId, record.id]);
      out.reprofiled.push(record.id);
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
