import { REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN } from "../../algorithm/fsrs-weights";
import type { SqlJsValue } from "../../database/sql-types";
import { DEFAULT_DECK_PROFILE, type DeckProfile, type ExamSettings } from "../../database/types";
import { isJsonObject, parseJson } from "../../utils/json";
import { hash64 } from "../../utils/hash";
import { parseSteps } from "../../utils/step-parser";
import { directoryDeckId } from "./ids";
import { DPKG_DAILY_LIMIT_MAX, isValidDpkgProfileKey, manifestPackageRef, type DpkgManifest, type DpkgProfile } from "./manifest";

export const DIRECTORY_PROFILE_PREFIX = "profile_dir_";

export function directoryProfileId(ref: string, key: string): string {
  return `${DIRECTORY_PROFILE_PREFIX}${hash64(`dir-profile:${ref}:${key}`)}`;
}

export function isDirectoryProfileId(id: string): boolean {
  return id.startsWith(DIRECTORY_PROFILE_PREFIX);
}

/** Selects the user's own profiles; package profiles are built on each device from the package, never copied. */
export const OWN_PROFILES_WHERE = `id NOT LIKE '${DIRECTORY_PROFILE_PREFIX}%'`;

/** Drops package profiles from a database about to be merged in. */
export const DROP_DIRECTORY_PROFILES_SQL = `DELETE FROM deckprofiles WHERE NOT (${OWN_PROFILES_WHERE})`;

/** A profile a package installs for its own decks, apart from every profile the user has. */
export interface DirectoryPackageProfile {
  id: string;
  key: string;
  /** Preferred name; a name another profile holds gets the slug added. */
  name: string;
  settings: DpkgProfile;
  exam: ExamSettings | null;
  deckKeys: string[];
}

const TTS_LANG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

function limit(enabled: boolean, value: number): number | null {
  return enabled ? Math.min(DPKG_DAILY_LIMIT_MAX, Math.max(0, Math.round(value))) : null;
}

function validSteps(value: string, fallback: string): string {
  return value.trim() === "" || parseSteps(value).length > 0 ? value.trim() : fallback;
}

/** The study settings of an author's profile, as a package carries them. */
export function dpkgProfileFrom(profile: DeckProfile, key: string): DpkgProfile {
  const ttsRate = profile.ttsRate;
  return {
    key,
    newCardsPerDay: limit(profile.hasNewCardsLimitEnabled, profile.newCardsPerDay),
    reviewCardsPerDay: limit(profile.hasReviewCardsLimitEnabled, profile.reviewCardsPerDay),
    reviewOrder: profile.reviewOrder,
    learningSteps: validSteps(profile.learningSteps, DEFAULT_DECK_PROFILE.learningSteps),
    relearningSteps: validSteps(profile.relearningSteps, DEFAULT_DECK_PROFILE.relearningSteps),
    requestRetention: Math.min(REQUEST_RETENTION_MAX, Math.max(REQUEST_RETENTION_MIN, profile.fsrs.requestRetention)),
    clozeShowContext: profile.clozeShowContext,
    ttsLang: profile.ttsLang && TTS_LANG_PATTERN.test(profile.ttsLang) ? profile.ttsLang : null,
    ttsRate: typeof ttsRate === "number" && ttsRate >= 0.1 && ttsRate <= 10 ? ttsRate : null,
  };
}

/** A key for an author's profile id that the manifest accepts, the same on every export. */
export function dpkgProfileKey(profileId: string): string {
  return isValidDpkgProfileKey(profileId) ? profileId : `p${hash64(profileId)}`;
}

/** The profiles a package carries, one per author profile its decks use, and the key each deck studies with. */
export function carriedProfiles(decks: readonly { key: string; profile: DeckProfile }[]): {
  profiles: DpkgProfile[];
  byDeck: Map<string, string>;
} {
  const profiles = new Map<string, DpkgProfile>();
  const byDeck = new Map<string, string>();
  for (const deck of decks) {
    const key = dpkgProfileKey(deck.profile.id);
    if (!profiles.has(key)) profiles.set(key, dpkgProfileFrom(deck.profile, key));
    byDeck.set(deck.key, key);
  }
  return { profiles: [...profiles.values()], byDeck };
}

// Packages that carry no profiles study with the shipped defaults; exam decks add no new cards, as the Exams preset.
function presetSettings(key: string, exam: boolean): DpkgProfile {
  return {
    key,
    newCardsPerDay: exam ? 0 : null,
    reviewCardsPerDay: null,
    reviewOrder: DEFAULT_DECK_PROFILE.reviewOrder,
    learningSteps: DEFAULT_DECK_PROFILE.learningSteps,
    relearningSteps: DEFAULT_DECK_PROFILE.relearningSteps,
    requestRetention: DEFAULT_DECK_PROFILE.fsrs.requestRetention,
    clozeShowContext: DEFAULT_DECK_PROFILE.clozeShowContext,
    ttsLang: null,
    ttsRate: null,
  };
}

/**
 * The profiles a package installs, one per profile its decks share. The first
 * deck's profile is named after the package; the others add their first deck's title.
 */
export function directoryPackageProfiles(
  manifest: Pick<DpkgManifest, "publisher" | "slug" | "title" | "decks" | "profiles">
): DirectoryPackageProfile[] {
  const declared = new Map(manifest.profiles.map((profile) => [profile.key, profile]));
  const groups = new Map<string, DirectoryPackageProfile>();
  for (const deck of manifest.decks) {
    const carried = deck.profile === null ? undefined : declared.get(deck.profile);
    // Synthesised keys hold a colon, which a carried key never does.
    const key = carried ? carried.key : deck.exam ? `preset:exam:${deck.key}` : "preset:study";
    let group = groups.get(key);
    if (!group) {
      group = {
        id: directoryProfileId(manifestPackageRef(manifest), key),
        key,
        name: "",
        settings: carried ?? presetSettings(key, deck.exam !== null),
        exam: deck.exam,
        deckKeys: [],
      };
      groups.set(key, group);
    }
    group.deckKeys.push(deck.key);
  }
  const titles = new Map(manifest.decks.map((deck) => [deck.key, deck.title]));
  const out = [...groups.values()];
  out.forEach((group, index) => {
    group.name = index === 0 ? manifest.title : `${manifest.title} · ${titles.get(group.deckKeys[0]) ?? group.key}`;
  });
  return out;
}

/** The package profile each deck of the given packages studies with, by deck id. */
export function directoryDeckProfileIds(
  manifests: readonly Pick<DpkgManifest, "publisher" | "slug" | "title" | "decks" | "profiles">[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const manifest of manifests) {
    for (const profile of directoryPackageProfiles(manifest)) {
      for (const key of profile.deckKeys) out.set(directoryDeckId(manifestPackageRef(manifest), key), profile.id);
    }
  }
  return out;
}

const DEFAULT_NEW_CARDS_PER_DAY = 20;
const DEFAULT_REVIEW_CARDS_PER_DAY = 100;

/** The columns of a package profile, as the package sets them; name and timestamps aside. */
export function packageProfileColumns(profile: DirectoryPackageProfile): Record<string, SqlJsValue> {
  const s = profile.settings;
  return {
    has_new_cards_limit_enabled: s.newCardsPerDay === null ? 0 : 1,
    new_cards_per_day: s.newCardsPerDay ?? DEFAULT_NEW_CARDS_PER_DAY,
    has_review_cards_limit_enabled: s.reviewCardsPerDay === null ? 0 : 1,
    review_cards_per_day: s.reviewCardsPerDay ?? DEFAULT_REVIEW_CARDS_PER_DAY,
    header_level: 2,
    extra_header_levels: "[]",
    review_order: s.reviewOrder,
    learning_steps: s.learningSteps,
    relearning_steps: s.relearningSteps,
    fsrs_request_retention: s.requestRetention,
    fsrs_profile: "STANDARD",
    cloze_enabled: 1,
    cloze_show_context: s.clozeShowContext,
    exam_enabled: profile.exam ? 1 : 0,
    exam_settings: profile.exam ? JSON.stringify(profile.exam) : "{}",
    tts_voice: null,
    tts_rate: s.ttsRate,
    tts_lang: s.ttsLang,
    is_default: 0,
  };
}

/** The study preferences a learner sets on a package's profile; the package keeps every other column. */
export const LEARNER_PROFILE_COLUMNS = [
  "has_new_cards_limit_enabled",
  "new_cards_per_day",
  "has_review_cards_limit_enabled",
  "review_cards_per_day",
  "review_order",
  "learning_steps",
  "relearning_steps",
  "fsrs_request_retention",
  "fsrs_profile",
  "cloze_show_context",
  "tts_voice",
  "tts_rate",
  "tts_lang",
] as const;

export type LearnerProfileColumn = (typeof LEARNER_PROFILE_COLUMNS)[number];
export type LearnerProfileSettings = Partial<Record<LearnerProfileColumn, SqlJsValue>>;

function isLearnerColumn(column: string): column is LearnerProfileColumn {
  return LEARNER_PROFILE_COLUMNS.some((known) => known === column);
}

function validLearnerValue(column: LearnerProfileColumn, value: SqlJsValue): boolean {
  switch (column) {
    case "has_new_cards_limit_enabled":
    case "has_review_cards_limit_enabled":
      return value === 0 || value === 1;
    case "new_cards_per_day":
    case "review_cards_per_day":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= DPKG_DAILY_LIMIT_MAX;
    case "review_order":
      return value === "due-date" || value === "random";
    case "learning_steps":
    case "relearning_steps":
      return typeof value === "string" && (value.trim() === "" || parseSteps(value).length > 0);
    case "fsrs_request_retention":
      return typeof value === "number" && value >= REQUEST_RETENTION_MIN && value <= REQUEST_RETENTION_MAX;
    case "fsrs_profile":
      return value === "STANDARD" || value === "TRAINED";
    case "cloze_show_context":
      return value === "open" || value === "hidden";
    case "tts_voice":
      return value === null || (typeof value === "string" && value.length <= 300);
    case "tts_rate":
      return value === null || (typeof value === "number" && value >= 0.1 && value <= 10);
    case "tts_lang":
      return value === null || (typeof value === "string" && TTS_LANG_PATTERN.test(value));
  }
}

/** A learner's stored settings; anything unknown or out of range is dropped. */
export function parseLearnerSettings(json: string | null | undefined): LearnerProfileSettings {
  const parsed = json ? parseJson(json) : null;
  if (!isJsonObject(parsed)) return {};
  const out: LearnerProfileSettings = {};
  for (const [column, value] of Object.entries(parsed)) {
    if (!isLearnerColumn(column)) continue;
    const cell = typeof value === "string" || typeof value === "number" || value === null ? value : undefined;
    if (cell !== undefined && validLearnerValue(column, cell)) out[column] = cell;
  }
  return out;
}

/** The learner columns a profile update sets, from its field names. */
export function learnerColumnsFromUpdates(updates: Partial<Omit<DeckProfile, "id" | "created" | "modified">>): LearnerProfileSettings {
  const out: LearnerProfileSettings = {};
  const bool = (value: boolean | undefined) => (value === undefined ? undefined : value ? 1 : 0);
  const pairs: [LearnerProfileColumn, SqlJsValue | undefined][] = [
    ["has_new_cards_limit_enabled", bool(updates.hasNewCardsLimitEnabled)],
    ["new_cards_per_day", updates.newCardsPerDay],
    ["has_review_cards_limit_enabled", bool(updates.hasReviewCardsLimitEnabled)],
    ["review_cards_per_day", updates.reviewCardsPerDay],
    ["review_order", updates.reviewOrder],
    ["learning_steps", updates.learningSteps],
    ["relearning_steps", updates.relearningSteps],
    ["fsrs_request_retention", updates.fsrs?.requestRetention],
    ["fsrs_profile", updates.fsrs?.profile],
    ["cloze_show_context", updates.clozeShowContext],
    ["tts_voice", "ttsVoice" in updates ? updates.ttsVoice || null : undefined],
    ["tts_rate", "ttsRate" in updates ? (updates.ttsRate ?? null) : undefined],
    ["tts_lang", "ttsLang" in updates ? updates.ttsLang || null : undefined],
  ];
  for (const [column, value] of pairs) if (value !== undefined) out[column] = value;
  return out;
}

/** The package-owned fields an update would change; a package's profile refuses these. */
export function packageOwnedChanges(
  current: DeckProfile,
  updates: Partial<Omit<DeckProfile, "id" | "created" | "modified">>
): string[] {
  const changed: string[] = [];
  if (updates.name !== undefined && updates.name !== current.name) changed.push("name");
  if (updates.headerLevel !== undefined && updates.headerLevel !== current.headerLevel) changed.push("headerLevel");
  if (
    updates.extraHeaderLevels !== undefined &&
    JSON.stringify(updates.extraHeaderLevels) !== JSON.stringify(current.extraHeaderLevels ?? [])
  ) {
    changed.push("extraHeaderLevels");
  }
  if (updates.clozeEnabled !== undefined && updates.clozeEnabled !== current.clozeEnabled) changed.push("clozeEnabled");
  if (updates.examEnabled !== undefined && updates.examEnabled !== (current.examEnabled ?? false)) changed.push("examEnabled");
  if (updates.examSettings !== undefined && stableJson(updates.examSettings) !== stableJson(current.examSettings ?? null)) {
    changed.push("examSettings");
  }
  return changed;
}

// The same value in the same text whatever order its keys were built in.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A learner's next settings: their current ones with these changes, keeping only what differs from the package. */
export function nextLearnerSettings(
  packageColumns: Readonly<Record<string, SqlJsValue>>,
  current: LearnerProfileSettings,
  changes: LearnerProfileSettings
): LearnerProfileSettings {
  const merged = parseLearnerSettings(JSON.stringify({ ...current, ...changes }));
  const out: LearnerProfileSettings = {};
  for (const column of LEARNER_PROFILE_COLUMNS) {
    const value = merged[column];
    if (value !== undefined && !samePackageValue(column, value, packageColumns[column])) out[column] = value;
  }
  return out;
}

// An unset read-aloud speed plays at the normal rate, so an editor's 1 matches it.
function samePackageValue(column: LearnerProfileColumn, value: SqlJsValue, packageValue: SqlJsValue | undefined): boolean {
  return value === packageValue || (column === "tts_rate" && value === 1 && packageValue === null);
}

/** A package profile's columns with the learner's settings laid over them. */
export function effectivePackageProfileColumns(
  profile: DirectoryPackageProfile,
  learner: LearnerProfileSettings
): Record<string, SqlJsValue> {
  return { ...packageProfileColumns(profile), ...learner };
}
