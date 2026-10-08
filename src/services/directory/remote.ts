import { isJsonObject, parseJson } from "../../utils/json";
import { DIRECTORY_PUBLISHER_ID, isValidDirectorySlug } from "./ids";
import type { DpkgManifest } from "./manifest";
import type { DirectoryMediaRef } from "./media-refs";

export const DECKS_DIRECTORY_BASE_URL = "https://decksmd.app/decks/api";

const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXT_PATTERN = /^[a-z0-9]{1,8}$/;

/** A version the directory published, by its archive's hash. */
export interface DirectoryPublishedVersion {
  version: number;
  sha256: string;
}

/** What the directory says about a deck before it is downloaded. */
export interface DirectoryDeckInfo {
  slug: string;
  title: string;
  version: number;
  cardCount: number;
  sizeBytes: number;
  /** Every published version, so a package file that claims to be the directory's can be checked. */
  versions: DirectoryPublishedVersion[];
}

export interface DirectoryImportRequest {
  slug: string;
  ticket: string;
}

export function directoryDeckInfoUrl(slug: string, base = DECKS_DIRECTORY_BASE_URL): string {
  return `${base}/decks/${encodeURIComponent(slug)}`;
}

export function directoryDownloadUrl(ticket: string, base = DECKS_DIRECTORY_BASE_URL): string {
  return `${base}/download?ticket=${encodeURIComponent(ticket)}`;
}

export function directoryMediaUrl(ref: DirectoryMediaRef, base = DECKS_DIRECTORY_BASE_URL): string | null {
  return SHA256_PATTERN.test(ref.sha256) && EXT_PATTERN.test(ref.ext) ? `${base}/media/${ref.sha256}.${ref.ext}` : null;
}

/** The parameters of an import link; anything malformed is refused, never guessed at. */
export function parseDirectoryImportRequest(params: Record<string, string | undefined>): DirectoryImportRequest | null {
  const slug = params.deck ?? "";
  const ticket = params.ticket ?? "";
  if (!isValidDirectorySlug(slug) || !TICKET_PATTERN.test(ticket)) return null;
  return { slug, ticket };
}

export function parseDirectoryDeckInfo(json: string): DirectoryDeckInfo | null {
  const parsed = parseJson(json);
  if (!isJsonObject(parsed)) return null;
  const { slug, title, version, cardCount, sizeBytes, versions } = parsed;
  if (typeof slug !== "string" || !isValidDirectorySlug(slug)) return null;
  if (typeof title !== "string" || typeof version !== "number") return null;
  const published = Array.isArray(versions)
    ? versions.flatMap((entry) =>
        isJsonObject(entry) && typeof entry.version === "number" && typeof entry.sha256 === "string" && SHA256_PATTERN.test(entry.sha256)
          ? [{ version: entry.version, sha256: entry.sha256 }]
          : []
      )
    : [];
  return {
    slug,
    title,
    version,
    cardCount: typeof cardCount === "number" ? cardCount : 0,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : 0,
    versions: published,
  };
}

/** Whether a package file naming the directory as publisher is one the directory published. */
export function isPublishedDirectoryArchive(info: DirectoryDeckInfo | null, slug: string, archiveSha256: string): boolean {
  return info !== null && info.slug === slug && info.versions.some((entry) => entry.sha256 === archiveSha256);
}

/** A package a directory link downloaded must be the directory's own, and the deck the link named. */
export function matchesDirectoryLink(manifest: Pick<DpkgManifest, "publisher" | "slug">, slug: string): boolean {
  return manifest.publisher.id === DIRECTORY_PUBLISHER_ID && manifest.slug === slug;
}

/** A file that names the directory as its publisher is checked against the directory before it is added. */
export function needsDirectoryCheck(manifest: Pick<DpkgManifest, "publisher">): boolean {
  return manifest.publisher.id === DIRECTORY_PUBLISHER_ID;
}
