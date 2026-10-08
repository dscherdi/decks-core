import { REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN } from "../../algorithm/fsrs-weights";
import {
  DEFAULT_DECK_PROFILE,
  parseExamSettings,
  type ClozeShowContext,
  type ExamSettings,
  type FlashcardType,
  type ReviewOrder,
} from "../../database/types";
import { parseSteps } from "../../utils/step-parser";
import { isJsonObject, isStringList, parseJson, type JsonObject } from "../../utils/json";
import { directoryPackageRef, isValidDirectoryDeckKey, isValidDirectoryPublisherId, isValidDirectorySlug } from "./ids";

// 2: packages name their publisher, part of their identity; earlier ones were never released.
// 3: exam cards may hold exercises and section text; written only by packages that use them.
export const DPKG_FORMAT_VERSION = 3;
export const DPKG_MIN_FORMAT_VERSION = 2;

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
  /** Key of the package profile this deck studies with; null on packages that carry none. */
  profile: string | null;
}

/** The study settings of an author's profile, carried so the decks review the way they were made. */
export interface DpkgProfile {
  /** Stable across versions, so an installed copy keeps the same profile. */
  key: string;
  /** Null when the author set no daily limit. */
  newCardsPerDay: number | null;
  reviewCardsPerDay: number | null;
  reviewOrder: ReviewOrder;
  learningSteps: string;
  relearningSteps: string;
  requestRetention: number;
  clozeShowContext: ClozeShowContext;
  ttsLang: string | null;
  ttsRate: number | null;
}

export const DPKG_DAILY_LIMIT_MAX = 9999;
const PROFILE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TTS_LANG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const TTS_RATE_MIN = 0.1;
const TTS_RATE_MAX = 10;

export function isValidDpkgProfileKey(key: string): boolean {
  return PROFILE_KEY_PATTERN.test(key);
}

/** Most decks one package may hold. */
export const MAX_PACKAGE_DECKS = 100;

/** Who made a package: a handle that is part of its identity, and a name to show. */
export interface DpkgPublisher {
  id: string;
  name: string;
}

export interface DpkgManifest {
  formatVersion: number;
  schemaVersion: number;
  publisher: DpkgPublisher;
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
  /** The profiles the decks study with; empty on packages written before profiles travelled. */
  profiles: DpkgProfile[];
}

export type DpkgErrorCode =
  | "not_a_package"
  | "newer_format"
  | "older_format"
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
  if (formatVersion < DPKG_MIN_FORMAT_VERSION) {
    throw new DpkgError("older_format", `Package format ${formatVersion} is no longer read; export it again`);
  }
  const publisher = publisherEntry(parsed.publisher);

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
    publisher,
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
    ...decksAndProfiles(parsed, title, cardCount),
  };
}

function publisherEntry(value: JsonObject[string] | undefined): DpkgPublisher {
  if (!isJsonObject(value)) fail("manifest.publisher must be an object");
  const id = text(value, "id");
  if (!isValidDirectoryPublisherId(id)) fail("manifest.publisher id is malformed");
  const name = text(value, "name", false).trim();
  if (name.length > 100) fail("manifest.publisher name is too long");
  return { id, name };
}

/** The package ref of a manifest: its publisher and slug. */
export function manifestPackageRef(manifest: Pick<DpkgManifest, "publisher" | "slug">): string {
  return directoryPackageRef(manifest.publisher.id, manifest.slug);
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
  const profile = value.profile === undefined || value.profile === null ? null : text(value, "profile");
  return {
    key,
    title,
    cardCount: count(value, "cardCount"),
    exam: examSettings(value.exam, "manifest.decks exam"),
    profile,
  };
}

function deckEntries(obj: JsonObject, title: string, cardCount: number): DpkgDeckEntry[] {
  // Packages written before decks were listed hold one deck, with its exam settings at the top.
  if (obj.decks === undefined) {
    return [{ key: "", title, cardCount, exam: examSettings(obj.exam, "manifest.exam"), profile: null }];
  }
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

function dailyLimit(obj: JsonObject, key: string): number | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > DPKG_DAILY_LIMIT_MAX) {
    fail(`manifest.profiles ${key} must be a whole number from 0 to ${DPKG_DAILY_LIMIT_MAX}`);
  }
  return value;
}

function steps(obj: JsonObject, key: string, fallback: string): string {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 200) fail(`manifest.profiles ${key} must be a string`);
  if (value.trim() !== "" && parseSteps(value).length === 0) fail(`manifest.profiles ${key} is malformed`);
  return value.trim();
}

function profileEntry(value: JsonObject[string]): DpkgProfile {
  if (!isJsonObject(value)) fail("manifest.profiles entries must be objects");
  const key = text(value, "key");
  if (!isValidDpkgProfileKey(key)) fail(`manifest.profiles key ${JSON.stringify(key)} is malformed`);
  const retention = value.requestRetention ?? DEFAULT_DECK_PROFILE.fsrs.requestRetention;
  if (typeof retention !== "number" || retention < REQUEST_RETENTION_MIN || retention > REQUEST_RETENTION_MAX) {
    fail(`manifest.profiles requestRetention must be from ${REQUEST_RETENTION_MIN} to ${REQUEST_RETENTION_MAX}`);
  }
  const ttsLang = value.ttsLang === undefined || value.ttsLang === null ? null : text(value, "ttsLang");
  if (ttsLang !== null && !TTS_LANG_PATTERN.test(ttsLang)) fail("manifest.profiles ttsLang is malformed");
  const ttsRate = value.ttsRate ?? null;
  if (ttsRate !== null && (typeof ttsRate !== "number" || ttsRate < TTS_RATE_MIN || ttsRate > TTS_RATE_MAX)) {
    fail("manifest.profiles ttsRate is out of range");
  }
  return {
    key,
    newCardsPerDay: dailyLimit(value, "newCardsPerDay"),
    reviewCardsPerDay: dailyLimit(value, "reviewCardsPerDay"),
    reviewOrder: value.reviewOrder === "random" ? "random" : "due-date",
    learningSteps: steps(value, "learningSteps", DEFAULT_DECK_PROFILE.learningSteps),
    relearningSteps: steps(value, "relearningSteps", DEFAULT_DECK_PROFILE.relearningSteps),
    requestRetention: retention,
    clozeShowContext: value.clozeShowContext === "open" ? "open" : "hidden",
    ttsLang,
    ttsRate,
  };
}

function decksAndProfiles(
  obj: JsonObject,
  title: string,
  cardCount: number
): Pick<DpkgManifest, "decks" | "profiles"> {
  const decks = deckEntries(obj, title, cardCount);
  if (obj.profiles !== undefined && !Array.isArray(obj.profiles)) fail("manifest.profiles must be a list");
  const profiles = (obj.profiles ?? []).map(profileEntry);
  if (profiles.length > MAX_PACKAGE_DECKS) fail(`manifest.profiles lists more than ${MAX_PACKAGE_DECKS} profiles`);
  const keys = new Set(profiles.map((profile) => profile.key));
  if (keys.size !== profiles.length) fail("manifest.profiles repeats a key");
  // A profile is an exam profile or not, so the decks sharing one agree on their exam.
  const examByProfile = new Map<string, string>();
  for (const deck of decks) {
    if (deck.profile === null) continue;
    if (!keys.has(deck.profile)) fail(`manifest.decks profile ${JSON.stringify(deck.profile)} is not listed`);
    const exam = JSON.stringify(deck.exam);
    const seen = examByProfile.get(deck.profile);
    if (seen !== undefined && seen !== exam) fail("decks sharing a profile have different exam settings");
    examByProfile.set(deck.profile, exam);
  }
  return { decks, profiles };
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
