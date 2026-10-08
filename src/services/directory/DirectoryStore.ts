import { DIRECTORY_TABLES_SQL } from "../../database/schemas";
import type { SqlJsValue } from "../../database/sql-types";
import { DEFAULT_PROFILE_ID, type DeckGroup, type DeckTemplate, type DeckWithProfile } from "../../database/types";
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
import {
  DIRECTORY_PATH_PREFIX,
  DIRECTORY_PUBLISHER_ID,
  directoryDeckId,
  directoryDeckPath,
  directoryDeckTag,
  directoryPackageRef,
} from "./ids";
import { DpkgError, examDeckKeys, manifestPackageRef, parseDpkgManifest, type DpkgManifest } from "./manifest";
import {
  DIRECTORY_PROFILE_PREFIX,
  directoryDeckProfileIds,
  directoryPackageProfiles,
  effectivePackageProfileColumns,
  parseLearnerSettings,
  type DirectoryPackageProfile,
} from "./profiles";

export interface DirectoryDeckRecord {
  id: string;
  publisher: string;
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
    publisher: text("publisher"),
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

/** The package ref of an installed package: its publisher and slug. */
export function directoryRecordRef(record: Pick<DirectoryDeckRecord, "publisher" | "slug">): string {
  return directoryPackageRef(record.publisher, record.slug);
}

/** An installed package's name in lists: its title, and its publisher's name unless it is the directory's own. */
export function directoryPackageLabel(record: Pick<DirectoryDeckRecord, "title" | "publisher" | "manifestJson">): string {
  if (record.publisher === DIRECTORY_PUBLISHER_ID) return record.title;
  return `${record.title} · ${manifestOf(record)?.publisher.name || record.publisher}`;
}

/** Idempotent; for databases created before the directory tables, or a column of them, existed. */
export function ensureDirectoryTables(db: RawDatabase): void {
  // Packages from before publishers were part of their identity were never released; drop them.
  if (hasTable(db, "directory_decks") && !columnsOf(db, "directory_decks").includes("publisher")) {
    for (const sql of DROP_UNPUBLISHED_DIRECTORY_SQL) {
      try {
        db.run(sql);
      } catch {
        // A database without that table has nothing to clear there.
      }
    }
  }
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
export function packageDeckIds(db: RawDatabase, ref: string): string[] {
  const root = directoryDeckPath(ref);
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
  const deckId = directoryDeckId(manifestPackageRef(manifest));
  const previous = getDirectoryDeck(db, deckId);

  db.run("SAVEPOINT directory_store");
  try {
    db.run(
      `INSERT INTO directory_decks (id, publisher, slug, version, title, description, manifest, archive_sha256,
         file_tags, imported_at, modified, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         publisher = excluded.publisher, slug = excluded.slug, version = excluded.version, title = excluded.title,
         description = excluded.description, manifest = excluded.manifest,
         archive_sha256 = excluded.archive_sha256, file_tags = excluded.file_tags,
         imported_at = excluded.imported_at, modified = excluded.modified, removed_at = NULL`,
      [
        deckId,
        manifest.publisher.id,
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

function manifestOf(record: Pick<DirectoryDeckRecord, "manifestJson">): DpkgManifest | null {
  try {
    return parseDpkgManifest(record.manifestJson);
  } catch {
    return null;
  }
}

/** The package profile each deck of the given packages studies with, by deck id. */
export function directoryDeckProfiles(records: readonly Pick<DirectoryDeckRecord, "manifestJson">[]): Map<string, string> {
  return directoryDeckProfileIds(records.flatMap((record) => manifestOf(record) ?? []));
}

/** The deck whose profile an exam on a whole package starts from: its first exam deck, as on the website. */
export function packageExamDeckId(
  records: readonly Pick<DirectoryDeckRecord, "publisher" | "slug" | "manifestJson">[],
  ref: string
): string | null {
  const record = records.find((candidate) => directoryRecordRef(candidate) === ref);
  const deck = record ? manifestOf(record)?.decks.find((entry) => entry.exam !== null) : undefined;
  return record && deck ? directoryDeckId(directoryRecordRef(record), deck.key) : null;
}

/**
 * A package's decks studied together: in the package's order, each keeping its own
 * daily limits, with the first deck's profile for the rest.
 */
export function directoryPackageGroup(
  record: Pick<DirectoryDeckRecord, "publisher" | "slug" | "title" | "manifestJson">,
  decks: readonly DeckWithProfile[],
  tag: string
): DeckGroup | null {
  const root = directoryDeckPath(directoryRecordRef(record));
  const order = (manifestOf(record)?.decks ?? []).map((deck) => directoryDeckId(directoryRecordRef(record), deck.key));
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const own = decks
    .filter((deck) => deck.filepath === root || deck.filepath.startsWith(`${root}/`))
    .sort((a, b) => rank(a.id) - rank(b.id));
  if (own.length === 0) return null;
  const latest = (values: (string | null)[]) => values.reduce<string | null>((max, v) => (v && (!max || v > max) ? v : max), null);
  return {
    type: "group",
    tag,
    name: directoryPackageLabel(record),
    deckIds: own.map((deck) => deck.id),
    profile: own[0].profile,
    deckLimits: true,
    lastReviewed: latest(own.map((deck) => deck.lastReviewed)),
    created: own.reduce((min, deck) => (deck.created < min ? deck.created : min), own[0].created),
    modified: latest(own.map((deck) => deck.modified)) ?? own[0].modified,
  };
}

/** The installed package a package profile belongs to, and how the package sets it. */
export function directoryPackageProfileOf(
  records: readonly Pick<DirectoryDeckRecord, "title" | "publisher" | "manifestJson" | "removedAt">[],
  profileId: string
): { title: string; profile: DirectoryPackageProfile } | null {
  for (const record of records) {
    if (record.removedAt !== null) continue;
    const manifest = manifestOf(record);
    const profile = manifest ? directoryPackageProfiles(manifest).find((candidate) => candidate.id === profileId) : undefined;
    if (profile) return { title: directoryPackageLabel(record), profile };
  }
  return null;
}

/** A deck's package profile, when it has one that is still live. */
export function livePackageProfile(
  byDeck: ReadonlyMap<string, string>,
  live: ReadonlySet<string>,
  deckId: string
): string | null {
  const id = byDeck.get(deckId);
  return id !== undefined && live.has(id) ? id : null;
}

/** The profile one deck of a package studies with: its package's own, else the default. */
export function resolveDirectoryProfileId(
  db: RawDatabase,
  record: Pick<DirectoryDeckRecord, "publisher" | "slug" | "manifestJson">,
  key = ""
): string {
  const own = directoryDeckProfiles([record]).get(directoryDeckId(directoryRecordRef(record), key)) ?? null;
  return own && liveProfile(db, own) ? own : DEFAULT_PROFILE_ID;
}

/** The first of the candidate names no other profile holds, removed ones included. */
function freeProfileName(db: RawDatabase, profile: DirectoryPackageProfile, publisher: string): string {
  const candidates = [profile.name, `${profile.name} (${publisher})`, `${profile.name} (${profile.id.slice(-8)})`];
  for (const name of candidates) {
    if (scalar(db, "SELECT 1 FROM deckprofiles WHERE name = ? AND id <> ?", [name, profile.id]) === undefined) return name;
  }
  return `${profile.name} (${profile.id})`;
}

function writePackageProfile(
  db: RawDatabase,
  profile: DirectoryPackageProfile,
  columns: Record<string, SqlJsValue>,
  name: string,
  stamp: string
): void {
  const names = Object.keys(columns);
  db.run(
    `INSERT INTO deckprofiles (id, name, ${names.join(", ")}, created, modified, deleted_at)
     VALUES (?, ?, ${names.map(() => "?").join(", ")}, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, ${names.map((n) => `${n} = excluded.${n}`).join(", ")},
       created = excluded.created, modified = excluded.modified, deleted_at = NULL`,
    [profile.id, name, ...names.map((n) => columns[n]), stamp, stamp]
  );
}

/** A learner's own settings for a package profile, as stored. */
export function loadLearnerSettings(db: RawDatabase, profileId: string): string | null {
  if (!hasTable(db, "directory_profile_settings")) return null;
  const value = scalar(db, SELECT_DIRECTORY_PROFILE_SETTINGS_SQL, [profileId]);
  return typeof value === "string" ? value : null;
}

/**
 * Keep a live package's own profiles as the package sets them, with the learner's settings laid
 * over: created, restored and put back after any other change. Each device builds its own.
 */
export function ensurePackageProfiles(db: RawDatabase, record: DirectoryDeckRecord): string[] {
  const manifest = manifestOf(record);
  if (!manifest || record.removedAt !== null) return [];
  const written: string[] = [];
  for (const profile of directoryPackageProfiles(manifest)) {
    const columns = effectivePackageProfileColumns(profile, parseLearnerSettings(loadLearnerSettings(db, profile.id)));
    const row = query(db, `SELECT name, deleted_at, ${Object.keys(columns).join(", ")} FROM deckprofiles WHERE id = ?`, [
      profile.id,
    ])[0];
    const live = row !== undefined && row.deleted_at === null;
    if (live && Object.entries(columns).every(([column, value]) => row[column] === value)) continue;
    const name = live ? String(row.name) : freeProfileName(db, profile, record.publisher);
    writePackageProfile(db, profile, columns, name, record.modified);
    written.push(profile.id);
  }
  return written;
}

/** Takes profile id, settings JSON and modified; a newer write wins. */
export const UPSERT_DIRECTORY_PROFILE_SETTINGS_SQL = `INSERT INTO directory_profile_settings (profile_id, settings, modified)
  VALUES (?, ?, ?)
  ON CONFLICT(profile_id) DO UPDATE SET settings = excluded.settings, modified = excluded.modified
  WHERE excluded.modified > directory_profile_settings.modified`;
export const SELECT_DIRECTORY_PROFILE_SETTINGS_SQL = "SELECT settings FROM directory_profile_settings WHERE profile_id = ?";

// Clears installs from before publishers were part of a package's identity; none were ever released.
const DIRECTORY_DECK_IDS = "SELECT id FROM decks WHERE filepath LIKE 'decks-directory:%'";
export const DROP_UNPUBLISHED_DIRECTORY_SQL: readonly string[] = [
  `DELETE FROM custom_deck_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id IN (${DIRECTORY_DECK_IDS}))`,
  `DELETE FROM cram_cards WHERE flashcard_id IN (SELECT id FROM flashcards WHERE deck_id IN (${DIRECTORY_DECK_IDS}))`,
  `DELETE FROM flashcards WHERE deck_id IN (${DIRECTORY_DECK_IDS})`,
  "DELETE FROM decks WHERE filepath LIKE 'decks-directory:%'",
  `DELETE FROM deckprofiles WHERE id LIKE '${DIRECTORY_PROFILE_PREFIX}%'`,
  "DROP TABLE IF EXISTS directory_decks",
  "DROP TABLE IF EXISTS directory_cards",
  "DROP TABLE IF EXISTS directory_templates",
];

/** Remove a removed package's profiles that nothing else studies with. */
export function retirePackageProfiles(db: RawDatabase, record: DirectoryDeckRecord, at: string): void {
  const manifest = manifestOf(record);
  if (!manifest) return;
  for (const profile of directoryPackageProfiles(manifest)) {
    db.run(
      `UPDATE deckprofiles SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM decks WHERE profile_id = ?)
         AND NOT EXISTS (SELECT 1 FROM profile_tag_mappings WHERE profile_id = ? AND deleted_at IS NULL)`,
      [at, profile.id, profile.id, profile.id]
    );
  }
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
  const ids = new Set(decks.map((deck) => directoryDeckId(directoryRecordRef(record), deck.key)));
  if (packageDeckIds(db, directoryRecordRef(record)).some((id) => !ids.has(id))) return true;
  return decks.some((deck) => {
    const id = directoryDeckId(directoryRecordRef(record), deck.key);
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
  const id = directoryDeckId(directoryRecordRef(record), deck.key);
  const path = directoryDeckPath(directoryRecordRef(record), deck.key);
  const tag = directoryDeckTag(directoryRecordRef(record), deck.key);
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
  ensurePackageProfiles(db, record);
  const decks = directoryPackageDecks(db, record);
  const keep = new Set(decks.map((deck) => directoryDeckId(directoryRecordRef(record), deck.key)));
  for (const stale of packageDeckIds(db, directoryRecordRef(record))) if (!keep.has(stale)) dropMaterialisedDeck(db, stale);
  const results = decks.map((deck) => materialiseOne(db, record, deck, now));
  // A card that moved between two of the package's decks is only free once its old deck let it go.
  decks.forEach((deck, index) => {
    if (workingCount(db, directoryDeckId(directoryRecordRef(record), deck.key)) !== storedCount(db, record, deck.key)) {
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
  ON d.filepath = '${DIRECTORY_PATH_PREFIX}' || p.publisher || '/' || p.slug
  OR d.filepath LIKE '${DIRECTORY_PATH_PREFIX}' || p.publisher || '/' || p.slug || '/%'
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
  /** Package profiles created, refreshed or restored. */
  profiles: string[];
}

export function materialiseChangedAnything(result: MaterialiseAllResult): boolean {
  return result.materialised.length + result.dropped.length + result.reprofiled.length + result.profiles.length > 0;
}

/**
 * Bring every directory deck's working rows in line with the stored content:
 * after a migration, a merge, an import or a removal on another device.
 */
export function materialiseDirectoryDecks(db: RawDatabase, now: string): MaterialiseAllResult {
  const out: MaterialiseAllResult = { materialised: [], dropped: [], reprofiled: [], profiles: [] };
  if (hasTable(db, "directory_decks")) ensureDirectoryTables(db);
  for (const record of listDirectoryDecks(db, true)) {
    if (record.removedAt !== null) {
      for (const id of packageDeckIds(db, directoryRecordRef(record))) {
        dropMaterialisedDeck(db, id);
        out.dropped.push(id);
      }
      retirePackageProfiles(db, record, record.removedAt);
      continue;
    }
    out.profiles.push(...ensurePackageProfiles(db, record));
    if (needsMaterialise(db, record)) {
      materialiseDirectoryDeck(db, record, now);
      out.materialised.push(record.id);
    }
    for (const deck of directoryPackageDecks(db, record)) {
      const id = directoryDeckId(directoryRecordRef(record), deck.key);
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
  retirePackageProfiles(db, current, at);
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
  ensureDirectoryTables(local);
  if (hasTable(remote, "directory_profile_settings")) {
    for (const row of query(remote, "SELECT profile_id, settings, modified FROM directory_profile_settings")) {
      local.run(UPSERT_DIRECTORY_PROFILE_SETTINGS_SQL, [row.profile_id ?? "", row.settings ?? "{}", row.modified ?? ""]);
    }
  }
  if (!hasTable(remote, "directory_decks") || !columnsOf(remote, "directory_decks").includes("publisher")) return [];
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
