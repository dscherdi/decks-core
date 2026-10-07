import { parseExamSettings, type ExamSettings, type FlashcardType } from "../../database/types";
import { isJsonObject, isStringList, parseJson, type JsonObject } from "../../utils/json";
import { isValidDirectorySlug } from "./ids";

export const DPKG_FORMAT_VERSION = 1;

export interface DpkgMediaEntry {
  sha256: string;
  ext: string;
  mime: string;
  size: number;
}

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
  /** Set on exam decks, which need an exam-enabled profile; their settings pre-fill an exam. */
  exam: ExamSettings | null;
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
    cardCount: count(parsed, "cardCount"),
    typeCounts,
    media: entries,
    dbSha256,
    createdAt: text(parsed, "createdAt"),
    generator: text(parsed, "generator", false),
    exam: examSettings(parsed),
  };
}

function examSettings(obj: JsonObject): ExamSettings | null {
  const value = obj.exam;
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) fail("manifest.exam must be an object");
  return parseExamSettings(JSON.stringify(value));
}

/** Whether a stored manifest marks an exam deck; unreadable manifests are not. */
export function isExamManifest(json: string): boolean {
  const parsed = parseJson(json);
  return isJsonObject(parsed) && isJsonObject(parsed.exam);
}

export function dpkgMediaPath(entry: Pick<DpkgMediaEntry, "sha256" | "ext">): string {
  return `media/${entry.sha256}.${entry.ext}`;
}
