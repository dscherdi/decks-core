import { CREATE_TABLES_SQL } from "../../database/schemas";
import type { SqlJsValue } from "../../database/sql-types";
import type { DeckTemplate, FlashcardType, TemplateFaceType, TemplateRow } from "../../database/types";
import { isJsonObject, isStringList, parseJson } from "../../utils/json";
import type { RawDatabase } from "../FlashcardSynchronizer";
import { directoryDeckId, directoryDeckKeyFromPath, directoryDeckPath, directoryDeckTag, isDirectoryDeckPath } from "./ids";
import { DPKG_MIN_FORMAT_VERSION, DpkgError, isFlashcardType, MAX_PACKAGE_DECKS } from "./manifest";
import { classifyExamBody } from "../ExamClassifier";

export const MAX_DIRECTORY_CARDS = 50_000;

/** The content of one packaged card; scheduling never travels in a package. */
export interface DirectoryCardContent {
  id: string;
  position: number;
  type: FlashcardType;
  front: string;
  back: string;
  notes: string;
  breadcrumb: string;
  clozeText: string | null;
  clozeOrder: number | null;
  hint: string;
  tags: string[];
  templateRow: TemplateRow | null;
  contentHash: string;
}

/** One deck of a package; a single-deck package's key is empty. */
export interface DirectoryDeckContent {
  key: string;
  name: string;
  fileTags: string[];
  cards: DirectoryCardContent[];
}

/** A package's decks, in the author's order, and the templates they share. */
export interface DirectoryPackageContent {
  decks: DirectoryDeckContent[];
  templates: DeckTemplate[];
}

/** The oldest format that holds this content, so older apps still install what they can show. */
export function dpkgFormatVersion(content: DirectoryPackageContent): number {
  const usesExercises = packageCards(content).some(
    (card) => card.type === "multiple-choice" && classifyExamBody(card.back).kind === "exercise"
  );
  return usesExercises ? 3 : DPKG_MIN_FORMAT_VERSION;
}

/** Every card of a package, deck by deck. */
export function packageCards(content: DirectoryPackageContent): DirectoryCardContent[] {
  return content.decks.flatMap((deck) => deck.cards);
}

type Row = Record<string, SqlJsValue>;

const CARD_ID_PATTERN = /^[a-z]+_[0-9a-z]+$/;

function invalid(message: string): never {
  throw new DpkgError("invalid_deck", message);
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function optStr(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function optInt(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function rows(db: RawDatabase, sql: string): Row[] {
  const stmt = db.prepare(sql);
  const out: Row[] = [];
  try {
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

function tableExists(db: RawDatabase, name: string): boolean {
  const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  stmt.bind([name]);
  const found = stmt.step();
  stmt.free();
  return found;
}

export function parseTemplateRow(raw: string | null): TemplateRow | null {
  const parsed = raw ? parseJson(raw) : null;
  if (!isJsonObject(parsed)) return null;
  const { headers, cells } = parsed;
  return isStringList(headers) && isStringList(cells) ? { headers, cells } : null;
}

export function parseStringList(raw: string | null): string[] {
  const parsed = raw ? parseJson(raw) : null;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function faceType(value: string | null, fallback: TemplateFaceType): TemplateFaceType {
  return value === "html" || value === "md" ? value : fallback;
}

export function templateFromRow(row: Row): DeckTemplate {
  return {
    id: str(row, "id"),
    sourceFile: str(row, "source_file"),
    tags: parseStringList(optStr(row, "tags")),
    frontTemplate: str(row, "front_template"),
    frontType: faceType(optStr(row, "front_type"), "md"),
    backTemplate: str(row, "back_template"),
    backType: faceType(optStr(row, "back_type"), "md"),
    notesTemplate: optStr(row, "notes_template"),
    notesType: optStr(row, "notes_type") === null ? null : faceType(optStr(row, "notes_type"), "md"),
    created: str(row, "created"),
    modified: str(row, "modified"),
  };
}

export function cardContentFromRow(row: Row, position: number): DirectoryCardContent {
  const id = str(row, "id");
  if (!CARD_ID_PATTERN.test(id)) invalid(`Card id ${JSON.stringify(id)} is malformed`);
  const type = str(row, "type");
  if (!isFlashcardType(type) || type === "spatial") invalid(`Card ${id} has an unsupported type`);
  const tagsRaw = str(row, "tags");
  return {
    id,
    position,
    type,
    front: str(row, "front"),
    back: str(row, "back"),
    notes: str(row, "notes"),
    breadcrumb: str(row, "breadcrumb"),
    clozeText: optStr(row, "cloze_text"),
    clozeOrder: optInt(row, "cloze_order"),
    hint: str(row, "hint"),
    tags: tagsRaw === "" ? [] : tagsRaw.split(",").filter((tag) => tag.length > 0),
    templateRow: parseTemplateRow(optStr(row, "template_row")),
    contentHash: str(row, "content_hash"),
  };
}

/** Read a package's deck.db. Columns are read by name, so older and newer layouts both load. */
export function readDpkgDeckDb(db: RawDatabase): DirectoryPackageContent {
  if (!tableExists(db, "decks") || !tableExists(db, "flashcards")) invalid("deck.db has no decks or flashcards table");
  const deckRows = rows(db, `SELECT * FROM decks ORDER BY rowid LIMIT ${MAX_PACKAGE_DECKS + 1}`);
  if (deckRows.length === 0) invalid("deck.db holds no deck");
  if (deckRows.length > MAX_PACKAGE_DECKS) invalid("deck.db holds too many decks");
  const decks = new Map<string, DirectoryDeckContent>();
  for (const row of deckRows) {
    const path = str(row, "filepath");
    if (!isDirectoryDeckPath(path)) invalid(`Deck ${JSON.stringify(path)} is not a package deck`);
    decks.set(str(row, "id"), {
      key: directoryDeckKeyFromPath(path),
      name: str(row, "name"),
      fileTags: parseStringList(optStr(row, "file_tags")),
      cards: [],
    });
  }
  if (decks.size !== deckRows.length) invalid("deck.db repeats a deck id");

  const cardRows = rows(db, `SELECT * FROM flashcards ORDER BY rowid LIMIT ${MAX_DIRECTORY_CARDS + 1}`);
  if (cardRows.length === 0) invalid("deck.db holds no cards");
  if (cardRows.length > MAX_DIRECTORY_CARDS) invalid("deck.db holds too many cards");
  const ids = new Set<string>();
  for (const row of cardRows) {
    const deck = decks.get(str(row, "deck_id"));
    if (!deck) invalid(`Card ${JSON.stringify(str(row, "id"))} belongs to no deck in the package`);
    const card = cardContentFromRow(row, deck.cards.length);
    if (ids.has(card.id)) invalid("deck.db repeats a card id");
    ids.add(card.id);
    deck.cards.push(card);
  }

  const templates = tableExists(db, "deck_templates")
    ? rows(db, "SELECT * FROM deck_templates ORDER BY rowid").map(templateFromRow)
    : [];

  return { decks: [...decks.values()], templates };
}

/**
 * Write a package into an empty database in the full Decks schema. Cards are
 * stored as new; ids, paths and tags are the ones every installer will use.
 */
export function writeDpkgDeckDb(
  db: RawDatabase,
  ref: string,
  content: DirectoryPackageContent,
  createdAt: string
): void {
  db.run(CREATE_TABLES_SQL);
  const insertDeck = db.prepare(
    `INSERT INTO decks (id, name, filepath, tag, last_reviewed, profile_id, created, modified, last_synced_mtime, file_tags)
     VALUES (?, ?, ?, ?, NULL, 'profile_default', ?, ?, 0, ?)`
  );
  const insertCard = db.prepare(
    `INSERT INTO flashcards (
       id, deck_id, front, back, type, source_file, content_hash, breadcrumb, notes,
       cloze_text, cloze_order, source_node_id, edge_id, hint,
       state, due_date, interval, repetitions, difficulty, stability, lapses, last_reviewed,
       created, modified, tags, suspended_at, buried_until, template_row, anchor
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'new', ?, 0, 0, 5.0, 0, 0, NULL, ?, ?, ?, NULL, NULL, ?, NULL)`
  );
  try {
    for (const deck of content.decks) {
      const deckId = directoryDeckId(ref, deck.key);
      const path = directoryDeckPath(ref, deck.key);
      insertDeck.run([
        deckId,
        deck.name,
        path,
        directoryDeckTag(ref, deck.key),
        createdAt,
        createdAt,
        JSON.stringify(deck.fileTags),
      ]);
      for (const card of [...deck.cards].sort((a, b) => a.position - b.position)) {
        insertCard.run([
          card.id,
          deckId,
          card.front,
          card.back,
          card.type,
          path,
          card.contentHash,
          card.breadcrumb,
          card.notes,
          card.clozeText,
          card.clozeOrder,
          card.hint,
          createdAt,
          createdAt,
          createdAt,
          card.tags.join(","),
          card.templateRow ? JSON.stringify(card.templateRow) : null,
        ]);
      }
    }
  } finally {
    insertDeck.free();
    insertCard.free();
  }

  const insertTemplate = db.prepare(
    `INSERT INTO deck_templates (
       id, source_file, tags, front_template, front_type, back_template, back_type,
       notes_template, notes_type, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    for (const template of content.templates) {
      insertTemplate.run([
        template.id,
        directoryDeckPath(ref),
        JSON.stringify(template.tags),
        template.frontTemplate,
        template.frontType,
        template.backTemplate,
        template.backType,
        template.notesTemplate,
        template.notesType,
        createdAt,
        createdAt,
      ]);
    }
  } finally {
    insertTemplate.free();
  }
}
