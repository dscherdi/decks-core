import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "../../utils/json";
import type { HttpClient } from "../ai/HttpClient";
import type { DirectoryDeckRecord } from "./DirectoryStore";
import { DIRECTORY_PUBLISHER_ID, isValidDirectorySlug } from "./ids";
import { DECKS_DIRECTORY_BASE_URL } from "./remote";

export type DirectoryCatalogSort = "updated" | "downloads" | "likes";

/** One deck of a listed package. */
export interface DirectoryCatalogPart {
  key: string;
  title: string;
  cardCount: number;
  exam: boolean;
}

/** A package as the directory lists it. */
export interface DirectoryCatalogDeck {
  slug: string;
  title: string;
  description: string;
  subject: string;
  language: string;
  topic: string;
  level: string;
  tags: string[];
  version: number;
  cardCount: number;
  sizeBytes: number;
  downloadCount: number;
  likeCount: number;
  /** The cover image's media file name, or null. */
  cover: string | null;
  updatedAt: string;
  decks: DirectoryCatalogPart[];
  /** Empty or "personal-use" means the directory's own terms. */
  license: string;
}

export interface DirectoryCatalogQuery {
  q?: string;
  subject?: string;
  language?: string;
  sort?: DirectoryCatalogSort;
  page?: number;
  /** Only these packages, such as the ones already installed. */
  slugs?: string[];
}

export interface DirectoryCatalogPage {
  decks: DirectoryCatalogDeck[];
  hasMore: boolean;
}

export interface DirectoryCatalogChoice {
  value: string;
  count: number;
}

export interface DirectoryCatalogFilters {
  subjects: DirectoryCatalogChoice[];
  languages: DirectoryCatalogChoice[];
}

/** What adding a listed package would do on this device. */
export interface DirectoryCatalogInstallState {
  state: "new" | "installed" | "update";
  installedVersion: number | null;
}

export class DirectoryCatalogError extends Error {
  constructor(readonly status: number) {
    super(`Deck directory request failed (${status})`);
    this.name = "DirectoryCatalogError";
  }
}

const COVER_PATTERN = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

/** The list of free packages; filtering and search happen on the directory. */
export function directoryCatalogUrl(query: DirectoryCatalogQuery, base = DECKS_DIRECTORY_BASE_URL): string {
  const params = new URLSearchParams({ free: "1" });
  if (query.q?.trim()) params.set("q", query.q.trim().slice(0, 100));
  if (query.subject) params.set("subject", query.subject);
  if (query.language) params.set("language", query.language);
  if (query.sort && query.sort !== "updated") params.set("sort", query.sort);
  if (query.page) params.set("page", String(query.page));
  if (query.slugs) params.set("slugs", query.slugs.join(","));
  return `${base}/decks?${params.toString()}`;
}

export function directoryFiltersUrl(base = DECKS_DIRECTORY_BASE_URL): string {
  return `${base}/filters?free=1`;
}

/** A free package's current archive, fetched without a website ticket. */
export function directoryPackageUrl(slug: string, base = DECKS_DIRECTORY_BASE_URL): string {
  return `${base}/decks/${encodeURIComponent(slug)}/package`;
}

export function directoryCoverUrl(cover: string | null, base = DECKS_DIRECTORY_BASE_URL): string | null {
  return cover && COVER_PATTERN.test(cover) ? `${base}/media/${cover}` : null;
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function count(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseParts(value: JsonValue | undefined, fallbackTitle: string, cardCount: number): DirectoryCatalogPart[] {
  const parts = Array.isArray(value)
    ? value.flatMap((entry) =>
        isJsonObject(entry) && typeof entry.key === "string" && typeof entry.title === "string"
          ? [{ key: entry.key, title: entry.title, cardCount: count(entry.cardCount), exam: isJsonObject(entry.exam) }]
          : []
      )
    : [];
  return parts.length > 0 ? parts : [{ key: "", title: fallbackTitle, cardCount, exam: false }];
}

function parseCatalogDeck(entry: JsonObject): DirectoryCatalogDeck | null {
  const { slug, title, version } = entry;
  if (typeof slug !== "string" || !isValidDirectorySlug(slug)) return null;
  if (typeof title !== "string" || typeof version !== "number") return null;
  const cardCount = count(entry.cardCount);
  return {
    slug,
    title,
    description: text(entry.description),
    subject: text(entry.subject),
    language: text(entry.language),
    topic: text(entry.topic),
    level: text(entry.level),
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
    version,
    cardCount,
    sizeBytes: count(entry.sizeBytes),
    downloadCount: count(entry.downloadCount),
    likeCount: count(entry.likeCount),
    cover: typeof entry.cover === "string" && COVER_PATTERN.test(entry.cover) ? entry.cover : null,
    updatedAt: text(entry.updatedAt),
    decks: parseParts(entry.decks, title, cardCount),
    license: text(entry.license),
  };
}

/** A page of the list; malformed entries are dropped rather than failing the page. */
export function parseDirectoryCatalogPage(json: string): DirectoryCatalogPage | null {
  const parsed = parseJson(json);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.decks)) return null;
  const decks = parsed.decks.flatMap((entry) => {
    const deck = isJsonObject(entry) ? parseCatalogDeck(entry) : null;
    return deck ? [deck] : [];
  });
  return { decks, hasMore: parsed.hasMore === true };
}

function parseChoices(value: JsonValue | undefined): DirectoryCatalogChoice[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        isJsonObject(entry) && typeof entry.value === "string" && entry.value !== ""
          ? [{ value: entry.value, count: count(entry.count) }]
          : []
      )
    : [];
}

export function parseDirectoryCatalogFilters(json: string): DirectoryCatalogFilters | null {
  const parsed = parseJson(json);
  if (!isJsonObject(parsed)) return null;
  return { subjects: parseChoices(parsed.subjects), languages: parseChoices(parsed.languages) };
}

async function getText(http: HttpClient, url: string, signal?: AbortSignal): Promise<string> {
  const response = await http.request({ url, method: "GET", headers: { Accept: "application/json" }, signal });
  if (response.status < 200 || response.status >= 300) throw new DirectoryCatalogError(response.status);
  return response.text;
}

export async function fetchDirectoryCatalog(
  http: HttpClient,
  query: DirectoryCatalogQuery,
  options: { base?: string; signal?: AbortSignal } = {}
): Promise<DirectoryCatalogPage> {
  const page = parseDirectoryCatalogPage(await getText(http, directoryCatalogUrl(query, options.base), options.signal));
  if (!page) throw new DirectoryCatalogError(0);
  return page;
}

export async function fetchDirectoryFilters(
  http: HttpClient,
  options: { base?: string; signal?: AbortSignal } = {}
): Promise<DirectoryCatalogFilters> {
  const filters = parseDirectoryCatalogFilters(await getText(http, directoryFiltersUrl(options.base), options.signal));
  if (!filters) throw new DirectoryCatalogError(0);
  return filters;
}

function installedRecord(slug: string, records: readonly DirectoryDeckRecord[]): DirectoryDeckRecord | undefined {
  return records.find(
    (record) => record.removedAt === null && record.publisher === DIRECTORY_PUBLISHER_ID && record.slug === slug
  );
}

export function catalogInstallState(
  deck: Pick<DirectoryCatalogDeck, "slug" | "version">,
  records: readonly DirectoryDeckRecord[]
): DirectoryCatalogInstallState {
  const record = installedRecord(deck.slug, records);
  if (!record) return { state: "new", installedVersion: null };
  return { state: deck.version > record.version ? "update" : "installed", installedVersion: record.version };
}

/** The directory's own packages installed on this device, for the Installed and Updates views. */
export function installedDirectorySlugs(records: readonly DirectoryDeckRecord[]): string[] {
  const slugs = records
    .filter((record) => record.removedAt === null && record.publisher === DIRECTORY_PUBLISHER_ID)
    .map((record) => record.slug);
  return [...new Set(slugs)].sort();
}

const HEADING_ONLY = /^\s{0,3}#{1,6}\s/;

/** A package description as one line of plain text: its opening paragraph when short enough, else cut at a word. */
export function directoryDescriptionSummary(source: string, max = 160): string {
  const opening = source.split(/\n\s*\n/).find((block) => block.trim() !== "" && !HEADING_ONLY.test(block));
  if (opening) {
    const plain = plainDescription(opening);
    if (plain && plain.length <= max) return plain;
  }
  return cutAtWord(plainDescription(source), max);
}

function plainDescription(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:(?:#{1,6}|>+|[-*+]|\d+[.)])\s+)+/gm, "")
    .replace(/[*`~]+/g, "")
    .replace(/(^|[\s(])_+|_+(?=[\s.,;:!?)]|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cutAtWord(source: string, max: number): string {
  if (source.length <= max) return source;
  const head = source.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,.;:–-]+$/, "")}…`;
}

/** Whether a package uses the directory's personal-use terms rather than a licence of its own. */
export function isPersonalUseLicense(license: string): boolean {
  return license === "" || license === "personal-use";
}

/** The deck directory's terms, in German where that version is the binding one. */
export function directoryTermsUrl(locale: string): string {
  return locale.toLowerCase().startsWith("de")
    ? "https://decksmd.app/legal/deck-verzeichnis"
    : "https://decksmd.app/legal/deck-directory";
}

/** A language code as a name in the reader's language, or the code itself when unknown. */
export function directoryLanguageName(code: string, locale: string): string {
  if (!code) return "";
  try {
    const names = new Intl.DisplayNames([locale], { type: "language" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** A subject as written in the catalog, with a capital first letter. */
export function directorySubjectLabel(subject: string): string {
  return subject ? subject.charAt(0).toUpperCase() + subject.slice(1) : subject;
}
