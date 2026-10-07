import { isJsonObject, parseJson } from "../../utils/json";
import { isValidDirectorySlug } from "./ids";

export const DECKS_DIRECTORY_BASE_URL = "https://decksmd.app/decks/api";

const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** What the directory says about a deck before it is downloaded. */
export interface DirectoryDeckInfo {
  slug: string;
  title: string;
  version: number;
  cardCount: number;
  sizeBytes: number;
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

export function directoryMediaUrl(sha256: string, base = DECKS_DIRECTORY_BASE_URL): string | null {
  return SHA256_PATTERN.test(sha256) ? `${base}/media/${sha256}` : null;
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
  const { slug, title, version, cardCount, sizeBytes } = parsed;
  if (typeof slug !== "string" || !isValidDirectorySlug(slug)) return null;
  if (typeof title !== "string" || typeof version !== "number") return null;
  return {
    slug,
    title,
    version,
    cardCount: typeof cardCount === "number" ? cardCount : 0,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : 0,
  };
}
