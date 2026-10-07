import { REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN } from "../../algorithm/fsrs-weights";
import { DEFAULT_DECK_PROFILE, type DeckProfile, type ExamSettings } from "../../database/types";
import { hash64 } from "../../utils/hash";
import { parseSteps } from "../../utils/step-parser";
import { directoryDeckId } from "./ids";
import { DPKG_DAILY_LIMIT_MAX, isValidDpkgProfileKey, type DpkgManifest, type DpkgProfile } from "./manifest";

export const DIRECTORY_PROFILE_PREFIX = "profile_dir_";

export function directoryProfileId(slug: string, key: string): string {
  return `${DIRECTORY_PROFILE_PREFIX}${hash64(`dir-profile:${slug}:${key}`)}`;
}

export function isDirectoryProfileId(id: string): boolean {
  return id.startsWith(DIRECTORY_PROFILE_PREFIX);
}

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
  manifest: Pick<DpkgManifest, "slug" | "title" | "decks" | "profiles">
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
        id: directoryProfileId(manifest.slug, key),
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
  manifests: readonly Pick<DpkgManifest, "slug" | "title" | "decks" | "profiles">[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const manifest of manifests) {
    for (const profile of directoryPackageProfiles(manifest)) {
      for (const key of profile.deckKeys) out.set(directoryDeckId(manifest.slug, key), profile.id);
    }
  }
  return out;
}
