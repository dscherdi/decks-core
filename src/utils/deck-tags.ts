import type { Deck, ProfileTagMapping } from "../database/types";
import { DIRECTORY_TAG_ROOT } from "../services/directory/ids";

/**
 * The tag vocabulary shared by both surfaces.
 *
 * A deck note carries one *deck tag* — a path under the configured base tag,
 * stored on `decks.tag` — plus whatever else sits in its frontmatter. The deck
 * tag decides what the note is; the rest are flat tags that only add grouping.
 * Both kinds end up in the same tag tree, so the splitting, matching and
 * normalising rules have to live in one place rather than being re-derived at
 * each call site.
 */

export interface TagScopeOptions {
  /** Base tag that marks a note as a deck (`#decks`). */
  baseTag: string;
  /** Tag patterns the user has excluded from the tag tree. */
  ignore?: readonly string[];
}

/**
 * Flat tags are compared case-insensitively, matching how card tags are already
 * normalised at parse time. Deck tags are deliberately left alone: lowercasing
 * them would re-key every existing group and orphan pins and profile mappings.
 */
export function normalizeTag(tag: string): string {
  return `#${tag.trim().replace(/^#/, "").replace(/\/+$/, "").toLowerCase()}`;
}

/** `#a/b/c` → `["#a", "#a/b", "#a/b/c"]`. */
export function ancestorTags(tag: string): string[] {
  const bare = tag.replace(/^#/, "");
  if (bare === "") return [];
  const segments = bare.split("/");
  const out: string[] = [];
  let cumulative = "";
  for (const segment of segments) {
    cumulative = cumulative ? `${cumulative}/${segment}` : segment;
    out.push(`#${cumulative}`);
  }
  return out;
}

/**
 * Whether `tag` is `base` or sits beneath it.
 *
 * The `/` boundary is the point: a bare `startsWith` also matches
 * `#decksforever`, which is a different tag that happens to share a prefix.
 */
export function isUnderTag(tag: string, base: string): boolean {
  const t = tag.replace(/^#/, "");
  const b = base.replace(/^#/, "").replace(/\/+$/, "");
  if (b === "") return false;
  return t === b || t.startsWith(`${b}/`);
}

/**
 * Whether a tag is excluded. A pattern matches the tag itself and everything
 * beneath it, so `status` also hides `status/todo`; a trailing `/*` is accepted
 * for readability and means the same thing.
 */
export function matchesIgnore(tag: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = normalizeTag(tag);
  for (const raw of patterns) {
    const pattern = normalizeTag(raw.replace(/\/\*+$/, ""));
    if (pattern === "#") continue;
    if (isUnderTag(normalized, pattern)) return true;
  }
  return false;
}

/**
 * Pick a note's deck tag out of everything it carries.
 *
 * Deepest wins, so a note tagged both `#decks` and `#decks/spanish` lands in the
 * specific group rather than the catch-all, and ties break lexically so two
 * devices scanning the same note always agree. Returns the base tag when the
 * note carries it plainly, and null when it carries nothing under it at all.
 */
export function pickDeckTag(tags: readonly string[], baseTag: string): string | null {
  const base = `#${baseTag.replace(/^#/, "").replace(/\/+$/, "")}`;
  const matching = tags
    .map((tag) => `#${tag.replace(/^#/, "")}`)
    .filter((tag) => isUnderTag(tag, base));
  if (matching.length === 0) return null;
  return matching.sort((a, b) => {
    const depth = b.split("/").length - a.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
  })[0];
}

/**
 * The flat tags a deck contributes to the tag tree — its frontmatter tags,
 * minus anything under the base tag (that is the deck tag's job) and minus
 * whatever the user has excluded.
 */
export function flatTagsFor(deck: Pick<Deck, "fileTags">, options: TagScopeOptions): string[] {
  const out = new Set<string>();
  for (const raw of deck.fileTags ?? []) {
    const tag = normalizeTag(raw);
    if (tag === "#") continue;
    if (isUnderTag(tag, options.baseTag)) continue;
    // Installed packages' decks own #directory; a note can't join them.
    if (isUnderTag(tag, DIRECTORY_TAG_ROOT)) continue;
    if (matchesIgnore(tag, options.ignore)) continue;
    out.add(tag);
  }
  return Array.from(out);
}

/**
 * Every tag a deck should be grouped under: its deck tag first, then its flat
 * tags. Order is meaningful — profile resolution reads it as a precedence list.
 */
export function studyTagsFor(
  deck: Pick<Deck, "tag" | "fileTags">,
  options: TagScopeOptions
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (tag: string) => {
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };
  if (deck.tag) push(deck.tag);
  for (const tag of flatTagsFor(deck, options)) push(tag);
  return out;
}

/**
 * Resolve a profile from a deck's tags, most specific mapping first.
 *
 * `tags` is a precedence list: the deck tag is tried on its own before any flat
 * tag is considered, so assigning a profile to `#decks/spanish` is never
 * overridden by a mapping the note picked up from `#math`. Within one tier the
 * longest mapped ancestor wins, and equal-length mappings break lexically so
 * the answer is stable across devices.
 */
export function pickProfileMapping(
  mappings: readonly ProfileTagMapping[],
  tags: readonly string[]
): string | null {
  if (mappings.length === 0) return null;
  for (const tag of tags) {
    const matching = mappings.filter((mapping) => isUnderTag(tag, mapping.tag));
    if (matching.length === 0) continue;
    matching.sort((a, b) => {
      const length = b.tag.length - a.tag.length;
      return length !== 0 ? length : a.tag.localeCompare(b.tag);
    });
    return matching[0].profileId;
  }
  return null;
}

/** Read the user's ignore-list setting, which is stored as free text. */
export function parseIgnoredTags(value: string | readonly string[] | undefined): string[] {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const tag = normalizeTag(String(part).replace(/\/\*+$/, ""));
    if (tag === "#" || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Build the tag scope from the parsing settings both surfaces store. */
export function tagScopeFromSettings(parsing: {
  deckTag?: string;
  ignoredTags?: string[];
} | undefined): TagScopeOptions {
  return {
    baseTag: parsing?.deckTag || "#decks",
    ignore: parseIgnoredTags(parsing?.ignoredTags),
  };
}
