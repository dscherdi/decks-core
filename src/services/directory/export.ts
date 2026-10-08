import type { Flashcard } from "../../database/types";
import { generateContentHash } from "../../utils/hash";
import { occlusionImageLinkpath, parseOcclusionBack, serializeOcclusionBack } from "../occlusion/OcclusionV2";
import type { DirectoryCardContent } from "./deck-db";
import { deriveDirectoryCardId } from "./ids";
import { directoryMediaPath, type DirectoryMediaRef } from "./media-refs";

const WIKI_EMBED = /!\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
const MD_IMAGE = /!\[([^\]\n]*)\]\(<?([^)>\s]+)>?\)/g;
const HTML_SRC = /(<(?:img|audio|video|source)\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const PACKAGED = /^media\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function isLocal(path: string): boolean {
  return !EXTERNAL.test(path) && !PACKAGED.test(path);
}

/** Vault paths a card's text embeds, as written (relative to its note). */
export function listVaultEmbeds(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(WIKI_EMBED)) if (isLocal(match[1])) out.add(match[1].trim());
  for (const match of text.matchAll(MD_IMAGE)) if (isLocal(match[2])) out.add(decode(match[2]));
  for (const match of text.matchAll(HTML_SRC)) if (isLocal(match[2])) out.add(decode(match[2]));
  return [...out];
}

/** Point a card's vault embeds at packaged media; embeds that do not resolve are reported and kept. */
export function rewriteVaultEmbeds(
  text: string,
  resolve: (linkpath: string) => DirectoryMediaRef | null
): { text: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const swap = (linkpath: string): string | null => {
    const ref = resolve(linkpath);
    if (!ref) unresolved.add(linkpath);
    return ref ? directoryMediaPath(ref) : null;
  };
  const rewritten = text
    .replace(WIKI_EMBED, (whole, path: string, hint?: string) => {
      if (!isLocal(path)) return whole;
      const media = swap(path.trim());
      return media ? `![[${media}${hint !== undefined ? `|${hint}` : ""}]]` : whole;
    })
    .replace(MD_IMAGE, (whole, alt: string, path: string) => {
      if (!isLocal(path)) return whole;
      const media = swap(decode(path));
      return media ? `![${alt}](${media})` : whole;
    })
    .replace(HTML_SRC, (whole, open: string, path: string, close: string) => {
      if (!isLocal(path)) return whole;
      const media = swap(decode(path));
      return media ? `${open}${media}${close}` : whole;
    });
  return { text: rewritten, unresolved: [...unresolved] };
}

/** Every vault path a set of cards needs packaged, including occlusion images. */
export function collectCardEmbeds(cards: Flashcard[]): string[] {
  const out = new Set<string>();
  for (const card of cards) {
    for (const text of [card.front, card.notes ?? ""]) for (const path of listVaultEmbeds(text)) out.add(path);
    const doc = card.type === "image-occlusion-v2" ? parseOcclusionBack(card.back) : null;
    if (doc) out.add(occlusionImageLinkpath(doc.image));
    else for (const path of listVaultEmbeds(card.back)) out.add(path);
  }
  return [...out];
}

export type ExportSkipReason = "unsupported_type";

export interface DirectoryExportResult {
  cards: DirectoryCardContent[];
  skipped: Array<{ id: string; reason: ExportSkipReason }>;
  unresolved: string[];
}

/** Card types a package can carry; multiple-choice only from an exam deck. */
function isPackable(card: Flashcard, exam: boolean): boolean {
  if (card.type === "spatial" || card.edgeId) return false;
  return card.type !== "multiple-choice" || exam;
}

/**
 * Turn a deck's cards into packaged content: ids derived from the package ref, media
 * pointed at the package, scheduling left behind.
 */
export function buildDirectoryCards(
  ref: string,
  cards: Flashcard[],
  resolve: (linkpath: string) => DirectoryMediaRef | null,
  options: { exam?: boolean } = {}
): DirectoryExportResult {
  const out: DirectoryExportResult = { cards: [], skipped: [], unresolved: [] };
  const unresolved = new Set<string>();
  const rewrite = (text: string): string => {
    const result = rewriteVaultEmbeds(text, resolve);
    result.unresolved.forEach((path) => unresolved.add(path));
    return result.text;
  };
  for (const card of cards) {
    if (!isPackable(card, options.exam === true)) {
      out.skipped.push({ id: card.id, reason: "unsupported_type" });
      continue;
    }
    let back = card.back;
    const doc = card.type === "image-occlusion-v2" ? parseOcclusionBack(card.back) : null;
    if (doc) {
      const linkpath = occlusionImageLinkpath(doc.image);
      const ref = resolve(linkpath);
      if (ref) back = serializeOcclusionBack({ ...doc, image: directoryMediaPath(ref) });
      else unresolved.add(linkpath);
    } else {
      back = rewrite(back);
    }
    const front = rewrite(card.front);
    const notes = rewrite(card.notes ?? "");
    out.cards.push({
      id: deriveDirectoryCardId(ref, card.id),
      position: out.cards.length,
      type: card.type,
      front,
      back,
      notes,
      breadcrumb: card.breadcrumb ?? "",
      clozeText: card.clozeText ?? null,
      clozeOrder: card.clozeOrder ?? null,
      hint: card.hint ?? "",
      tags: card.tags ?? [],
      templateRow: card.templateRow ?? null,
      contentHash: generateContentHash(
        JSON.stringify([front, back, notes, card.clozeText ?? null, card.templateRow?.cells ?? null])
      ),
    });
  }
  out.unresolved = [...unresolved];
  return out;
}
