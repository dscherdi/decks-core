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

export function directoryDeckId(slug: string): string {
  return `deck_dir_${hash64(`dir-deck:${slug}`)}`;
}

export function directoryDeckPath(slug: string): string {
  return `${DIRECTORY_PATH_PREFIX}${slug}`;
}

export function directoryDeckTag(slug: string): string {
  return `${DIRECTORY_TAG_ROOT}/${slug}`;
}

export function isDirectoryDeckPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith(DIRECTORY_PATH_PREFIX);
}

export function isDirectoryDeck(deck: Pick<Deck, "filepath">): boolean {
  return isDirectoryDeckPath(deck.filepath);
}

export function directorySlugFromPath(path: string): string | null {
  return isDirectoryDeckPath(path) ? path.slice(DIRECTORY_PATH_PREFIX.length) : null;
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
