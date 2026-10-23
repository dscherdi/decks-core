import type { Flashcard } from "../../database/types";
import { cardIdForKey, reverseBindingKey } from "../../utils/anchors";
import { wantsReverseCards } from "../../utils/frontmatter";
import { generateContentHash } from "../../utils/hash";
import { FlashcardParser, type ParsedFlashcard } from "../FlashcardParser";
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

/** How the deck's profile parses its note. */
export interface NoteOrderOptions {
  headerLevels: number[];
  /** The note's name, the front of a title-mode card. */
  fileTitle?: string;
  clozeEnabled?: boolean;
  examEnabled?: boolean;
}

type NoteCard = Pick<ParsedFlashcard, "type" | "front" | "back" | "breadcrumb" | "clozeOrder" | "anchorKey">;

const NEVER_REVERSED = new Set<Flashcard["type"]>([
  "cloze",
  "image-occlusion",
  "image-occlusion-v2",
  "spatial",
  "multiple-choice",
]);

function contentKey(card: Pick<Flashcard, "type" | "front" | "back"> & { breadcrumb?: string; clozeOrder?: number | null }): string {
  return JSON.stringify([card.type, card.front, card.back, card.breadcrumb ?? "", card.clozeOrder ?? null]);
}

// Reverse cards follow every note card, as a sync adds them.
function withReverses(parsed: ParsedFlashcard[], reverse: boolean): NoteCard[] {
  if (!reverse) return parsed;
  const reverses = parsed
    .filter((card) => card.back && !card.edgeId && !NEVER_REVERSED.has(card.type))
    .map((card) => ({
      type: card.type,
      front: card.back,
      back: card.front,
      breadcrumb: card.breadcrumb,
      anchorKey: card.anchorKey ? reverseBindingKey(card.anchorKey) : undefined,
    }));
  return [...parsed, ...reverses];
}

/**
 * A deck's cards in the order its note lays them out. Each parsed card claims its row by
 * token, then by content; rows the note doesn't place keep their order at the end.
 */
export function sortCardsInNoteOrder(cards: Flashcard[], content: string, options: NoteOrderOptions): Flashcard[] {
  const parsed = FlashcardParser.parseInNoteOrder(
    content,
    options.headerLevels,
    options.fileTitle,
    options.clozeEnabled === true,
    options.examEnabled === true
  );
  const byId = new Map<string, Flashcard>();
  const byAnchor = new Map<string, Flashcard>();
  const byContent = new Map<string, Flashcard[]>();
  for (const card of cards) {
    byId.set(card.id, card);
    if (card.anchor) byAnchor.set(card.anchor, card);
    const key = contentKey(card);
    const twins = byContent.get(key);
    if (twins) twins.push(card);
    else byContent.set(key, [card]);
  }
  const placed = new Set<string>();
  const ordered: Flashcard[] = [];
  const claim = (card: Flashcard | undefined): boolean => {
    if (!card || placed.has(card.id)) return false;
    placed.add(card.id);
    ordered.push(card);
    return true;
  };
  for (const card of withReverses(parsed, wantsReverseCards(content))) {
    const key = card.anchorKey;
    if (key && (claim(byAnchor.get(key)) || claim(byId.get(cardIdForKey(key) ?? "")))) continue;
    claim(byContent.get(contentKey(card))?.find((row) => !placed.has(row.id)));
  }
  return [...ordered, ...cards.filter((card) => !placed.has(card.id))];
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
