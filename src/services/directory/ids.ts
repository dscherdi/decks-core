import type { Deck } from "../../database/types";
import { hash64 } from "../../utils/hash";

export const DPKG_EXTENSION = ".dpkg";
export const DPKG_MIME_TYPE = "application/vnd.decksmd.dpkg";

// A colon can never appear in a vault path, so these never collide with a note.
export const DIRECTORY_PATH_PREFIX = "decks-directory:";
export const DIRECTORY_TAG_ROOT = "#directory";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 80;

export function isValidDirectorySlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
}

/** A slug suggested from a title: "Español básico" → "espanol-basico". */
export function slugifyDirectoryTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * A package holds one deck or several, each under a key; a single deck's key is
 * empty, so its id, path and tag are the package's own.
 */
export function isValidDirectoryDeckKey(key: string): boolean {
  return key === "" || isValidDirectorySlug(key);
}

export function directoryDeckId(slug: string, key = ""): string {
  return `deck_dir_${hash64(key ? `dir-deck:${slug}/${key}` : `dir-deck:${slug}`)}`;
}

export function directoryDeckPath(slug: string, key = ""): string {
  return `${DIRECTORY_PATH_PREFIX}${slug}${key ? `/${key}` : ""}`;
}

/** A tag under `#directory`; a package's decks carry these, and only Customize maps them. */
export function isDirectoryTag(tag: string): boolean {
  const lower = tag.toLowerCase();
  return lower === DIRECTORY_TAG_ROOT || lower.startsWith(`${DIRECTORY_TAG_ROOT}/`);
}

export function directoryDeckTag(slug: string, key = ""): string {
  return `${DIRECTORY_TAG_ROOT}/${slug}${key ? `/${key}` : ""}`;
}

export function isDirectoryDeckPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith(DIRECTORY_PATH_PREFIX);
}

export function isDirectoryDeck(deck: Pick<Deck, "filepath">): boolean {
  return isDirectoryDeckPath(deck.filepath);
}

/** The package slug of a directory deck path, without the deck key. */
export function directorySlugFromPath(path: string): string | null {
  if (!isDirectoryDeckPath(path)) return null;
  const rest = path.slice(DIRECTORY_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(0, slash);
}

/** The deck key within its package; empty for a single-deck package. */
export function directoryDeckKeyFromPath(path: string): string {
  if (!isDirectoryDeckPath(path)) return "";
  const rest = path.slice(DIRECTORY_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? "" : rest.slice(slash + 1);
}

/** The id of the installed package a directory deck belongs to. */
export function directoryPackageIdFromPath(path: string): string | null {
  const slug = directorySlugFromPath(path);
  return slug ? directoryDeckId(slug) : null;
}

/**
 * A packaged card's id: the owner's id prefix (which encodes the card kind) and
 * a 64-bit hash of slug + owner id, so updates keep ids and never meet 31-bit ones.
 */
export function deriveDirectoryCardId(slug: string, ownerCardId: string): string {
  const underscore = ownerCardId.indexOf("_");
  const prefix = underscore > 0 ? ownerCardId.slice(0, underscore + 1) : "card_";
  return `${prefix}${hash64(`dir:${slug}:${ownerCardId}`)}`;
}
