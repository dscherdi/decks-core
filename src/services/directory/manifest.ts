import { parseExamSettings, type ExamSettings, type FlashcardType } from "../../database/types";
import { isJsonObject, isStringList, parseJson, type JsonObject } from "../../utils/json";
import { isValidDirectoryDeckKey, isValidDirectorySlug } from "./ids";

export const DPKG_FORMAT_VERSION = 1;

export interface DpkgMediaEntry {
  sha256: string;
  ext: string;
  mime: string;
  size: number;
}

export interface DpkgDeckEntry {
  /** Empty for a single-deck package; otherwise stable across versions, as progress follows it. */
  key: string;
  title: string;
  cardCount: number;
  /** Set on exam decks, which need an exam-enabled profile; the settings pre-fill an exam. */
  exam: ExamSettings | null;
}

/** Most decks one package may hold. */
export const MAX_PACKAGE_DECKS = 100;

export interface DpkgManifest {
  formatVersion: number;
  schemaVersion: number;
  slug: string;
  /** Monotonic per slug; a higher version replaces an installed lower one. */
  version: number;
  title: string;
  description: string;
  language: string;
  subject: string;
  tags: string[];
  license: string;
  cardCount: number;
  typeCounts: Partial<Record<FlashcardType, number>>;
  media: DpkgMediaEntry[];
  dbSha256: string;
  createdAt: string;
  generator: string;
  /** The decks in the package, in the order the author arranged them. */
  decks: DpkgDeckEntry[];
}

export type DpkgErrorCode =
  | "not_a_package"
  | "newer_format"
  | "invalid_manifest"
  | "too_large"
  | "hash_mismatch"
  | "missing_entry"
  | "invalid_deck";

export class DpkgError extends Error {
  constructor(public readonly code: DpkgErrorCode, message: string) {
    super(message);
    this.name = "DpkgError";
  }
}

const FLASHCARD_TYPES: readonly FlashcardType[] = [
  "header-paragraph",
  "table",
  "cloze",
  "image-occlusion",
  "image-occlusion-v2",
  "spatial",
  "multiple-choice",
];

export function isFlashcardType(value: string): value is FlashcardType {
  return FLASHCARD_TYPES.some((type) => type === value);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXT_PATTERN = /^[a-z0-9]{1,8}$/;
const TEXT_LIMIT = 10_000;

function fail(message: string): never {
  throw new DpkgError("invalid_manifest", message);
}


function text(obj: JsonObject, key: string, required = true): string {
  const value = obj[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > TEXT_LIMIT) fail(`manifest.${key} must be a string`);
  return value;
}

function count(obj: JsonObject, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`manifest.${key} must be a non-negative integer`);
  }
  return value;
}

function stringList(obj: JsonObject, key: string): string[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!isStringList(value)) fail(`manifest.${key} must be a list of strings`);
  return value;
}

function mediaEntry(value: JsonObject[string]): DpkgMediaEntry {
  if (!isJsonObject(value)) fail("manifest.media entries must be objects");
  const sha256 = text(value, "sha256");
  const ext = text(value, "ext");
  if (!SHA256_PATTERN.test(sha256)) fail("manifest.media sha256 is malformed");
  if (!EXT_PATTERN.test(ext)) fail("manifest.media ext is malformed");
  return { sha256, ext, mime: text(value, "mime"), size: count(value, "size") };
}

/** Parse and validate a manifest; refuses formats newer than this build reads. */
export function parseDpkgManifest(json: string): DpkgManifest {
  const parsed = parseJson(json);
  if (parsed === null) throw new DpkgError("invalid_manifest", "manifest.json is not valid JSON");
  if (!isJsonObject(parsed)) fail("manifest.json must hold an object");

  const formatVersion = count(parsed, "formatVersion");
  if (formatVersion > DPKG_FORMAT_VERSION) {
    throw new DpkgError("newer_format", `Package format ${formatVersion} is newer than this version reads`);
  }

  const slug = text(parsed, "slug");
  if (!isValidDirectorySlug(slug)) fail("manifest.slug is malformed");
  const dbSha256 = text(parsed, "dbSha256");
  if (!SHA256_PATTERN.test(dbSha256)) fail("manifest.dbSha256 is malformed");

  const media = parsed.media;
  if (media !== undefined && !Array.isArray(media)) fail("manifest.media must be a list");
  const entries = (media ?? []).map(mediaEntry);
  if (new Set(entries.map((entry) => entry.sha256)).size !== entries.length) {
    fail("manifest.media lists a file twice");
  }

  const typeCounts: Partial<Record<FlashcardType, number>> = {};
  const rawCounts = parsed.typeCounts;
  if (isJsonObject(rawCounts)) {
    for (const [type, value] of Object.entries(rawCounts)) {
      if (typeof value === "number" && isFlashcardType(type)) typeCounts[type] = value;
    }
  }

  const version = count(parsed, "version");
  if (version < 1) fail("manifest.version must be at least 1");
  const title = text(parsed, "title").trim();
  if (title === "") fail("manifest.title is empty");
  const cardCount = count(parsed, "cardCount");

  return {
    formatVersion,
    schemaVersion: count(parsed, "schemaVersion"),
    slug,
    version,
    title,
    description: text(parsed, "description", false),
    language: text(parsed, "language", false),
    subject: text(parsed, "subject", false),
    tags: stringList(parsed, "tags"),
    license: text(parsed, "license", false),
    cardCount,
    typeCounts,
    media: entries,
    dbSha256,
    createdAt: text(parsed, "createdAt"),
    generator: text(parsed, "generator", false),
    decks: deckEntries(parsed, title, cardCount),
  };
}

function examSettings(value: JsonObject[string] | undefined, where: string): ExamSettings | null {
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) fail(`${where} must be an object`);
  return parseExamSettings(JSON.stringify(value));
}

function deckEntry(value: JsonObject[string]): DpkgDeckEntry {
  if (!isJsonObject(value)) fail("manifest.decks entries must be objects");
  const key = text(value, "key", false);
  if (!isValidDirectoryDeckKey(key)) fail(`manifest.decks key ${JSON.stringify(key)} is malformed`);
  const title = text(value, "title").trim();
  if (title === "") fail("manifest.decks title is empty");
  return { key, title, cardCount: count(value, "cardCount"), exam: examSettings(value.exam, "manifest.decks exam") };
}

function deckEntries(obj: JsonObject, title: string, cardCount: number): DpkgDeckEntry[] {
  // Packages written before decks were listed hold one deck, with its exam settings at the top.
  if (obj.decks === undefined) return [{ key: "", title, cardCount, exam: examSettings(obj.exam, "manifest.exam") }];
  if (!Array.isArray(obj.decks) || obj.decks.length === 0) fail("manifest.decks must be a non-empty list");
  if (obj.decks.length > MAX_PACKAGE_DECKS) fail(`manifest.decks lists more than ${MAX_PACKAGE_DECKS} decks`);
  const entries = obj.decks.map(deckEntry);
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) fail("manifest.decks repeats a key");
  const single = entries.length === 1;
  if (entries.some((entry) => (entry.key === "") !== single)) {
    fail("a single deck has an empty key; every deck of a larger package has its own");
  }
  if (entries.reduce((sum, entry) => sum + entry.cardCount, 0) !== cardCount) {
    fail("manifest.decks card counts do not add up to manifest.cardCount");
  }
  return entries;
}

/** Keys of the exam decks a stored manifest lists; an unreadable manifest lists none. */
export function examDeckKeys(json: string): Set<string> {
  const parsed = parseJson(json);
  if (!isJsonObject(parsed)) return new Set();
  if (!Array.isArray(parsed.decks)) return new Set(isJsonObject(parsed.exam) ? [""] : []);
  return new Set(
    parsed.decks.flatMap((entry) =>
      isJsonObject(entry) && isJsonObject(entry.exam) && typeof entry.key === "string" ? [entry.key] : []
    )
  );
}

export function dpkgMediaPath(entry: Pick<DpkgMediaEntry, "sha256" | "ext">): string {
  return `media/${entry.sha256}.${entry.ext}`;
}
