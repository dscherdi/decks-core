import type { AnkiParsedCard } from "./AnkiTypes";
import { escapeTableCell, hasBlockMarkdown } from "../../../utils/markdown-table";
import { splitClozeHeader } from "./ClozeLayout";
import { OcclusionV2Parser } from "../../occlusion/OcclusionV2Parser";
import { OCCLUSION_V2_VERSION } from "../../occlusion/OcclusionV2.types";
import {
  generateAnchorId,
  generateClozeFlashcardId,
  generateFlashcardId,
  generateOcclusionV2FlashcardId,
  hash64,
} from "../../../utils/hash";
import {
  encodeAnchorValue,
  formatAnchorToken,
  isIdKey,
  type AnchorRole,
} from "../../../utils/anchors";
import { scanClozeDeletions } from "../../../utils/cloze-scanner";
import type { IDatabaseService } from "../../../database/DatabaseService.interface";
import { occlusionImageName } from "../../occlusion/OcclusionV2";

export interface AnkiAnchorBinding {
  anchor: string;
  flashcardId: string;
}

export interface AnkiRenderedDeck {
  deckName: string; // original Anki deck path ("Parent::Child")
  relativePath: string; // vault-relative path without extension, mirroring the hierarchy
  tag: string; // deck tag for the file's frontmatter (no leading #)
  content: string; // full markdown file content
  cards: AnkiParsedCard[]; // every card for this deck (each cloze ord kept, for history)
  // Binding rows for the emitted tokens, for versions that still resolve through them.
  bindings: AnkiAnchorBinding[];
}

/** What one render pass threads through its sections. */
interface RenderContext {
  bindings: AnkiAnchorBinding[];
  // Binding key -> id for tokens an earlier import wrote; those cards keep their ids.
  pins: ReadonlyMap<string, string>;
  // Every parsed card of a note, so all of a cloze note's cards learn their ids.
  noteCards: ReadonlyMap<number, AnkiParsedCard[]>;
}

/** A card row an earlier import left in the target folder. */
export interface AnkiEarlierRow {
  id: string;
  front: string;
  back: string;
  // The deck file it is in, relative to the folder and without ".md".
  path: string;
}

export interface AnkiRenderOptions {
  // Binding key -> id for tokens an earlier import wrote; those cards keep their ids.
  pins?: ReadonlyMap<string, string>;
  // Rows already in the target folder; a re-imported card keeps a " (n)" front it had.
  earlierRows?: readonly AnkiEarlierRow[];
}

const SUFFIXED_FRONT = /^([\s\S]*) \((\d+)\)$/;

/** Card rows in `folder` (a vault path ending in "/"), for `render`'s `earlierRows`. */
export async function readAnkiEarlierRows(
  db: Pick<IDatabaseService, "querySql">,
  folder: string
): Promise<AnkiEarlierRow[]> {
  const rows = await db.querySql<{ id: string; front: string; back: string; filepath: string }>(
    `SELECT f.id AS id, f.front AS front, f.back AS back, d.filepath AS filepath FROM flashcards f
     JOIN decks d ON f.deck_id = d.id
     WHERE substr(d.filepath, 1, length(?)) = ?
     ORDER BY f.id`,
    [folder, folder],
    { asObject: true }
  );
  return rows.map(({ filepath, ...row }) => ({
    ...row,
    path: filepath.slice(folder.length).replace(/\.md$/i, ""),
  }));
}

/** Binding rows an earlier import may have written, for `render`'s `pins`. */
export async function readAnkiPins(
  db: Pick<IDatabaseService, "querySql">
): Promise<Map<string, string>> {
  const rows = await db.querySql<{ anchor: string; flashcard_id: string }>(
    "SELECT anchor, flashcard_id FROM anchor_bindings",
    [],
    { asObject: true }
  );
  return new Map(
    rows.filter((row) => !isIdKey(row.anchor)).map((row) => [row.anchor, row.flashcard_id])
  );
}

// A rendered section plus the keys it's ordered by within a deck file.
interface RenderedSection {
  sortTag: string; // joined note tags ("" = untagged → sorts first)
  sortHeader: string; // header text (no tags) for the secondary A–Z sort
  content: string; // the full `## …` markdown section
}

const ILLEGAL_PATH = /[\\/:*?"<>|#^[\]]/g;

// Tidy a table cell value: drop trailing whitespace per line and collapse blank
// runs so cells don't pad columns with stray whitespace.
function cleanCell(s: string): string {
  return s
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A deck with at least this many header-paragraph basic cards collapses them all
// into the aggregated table instead of a long wall of `## …` sections.
const HEADER_PARAGRAPH_TABLE_THRESHOLD = 50;

// A deck is split into subfoldered part-files so each file stays openable in
// Obsidian and under the per-deck sync limit. A file is capped on card count AND
// on media-embed count (whichever is hit first): a file with thousands of
// audio/image embeds lags reading view even with a modest row count.
// Cards-per-file is user-overridable at import time; media-per-file is a fixed
// safety rail.
export const DEFAULT_ANKI_CARDS_PER_FILE = 1000;
const MEDIA_PER_FILE = 500;

/**
 * Turns parsed Anki cards into one Decks markdown file per Anki deck. Cloze notes
 * collapse to a single entry (Decks expands the `==highlights==` into per-cloze
 * cards); every other card becomes its own entry, including reverse templates.
 * Basic cards default to header-paragraph and escalate to an aggregated table
 * (grouped by column structure) when compact; template/cloze/occlusion cards keep
 * their own layout.
 */
export class AnkiDeckRenderer {
  /**
   * @param baseTag the migration subtag every deck tag nests under (no `#`,
   *   e.g. "decks/anki"). Profile mapping is applied to this subtag.
   */
  static render(
    cards: AnkiParsedCard[],
    baseTag: string,
    headerLevel: number,
    // When false, a deck is never broken into numbered part-files (one file per
    // deck regardless of size). Subdecks still map to separate files either way.
    split = true,
    // Max cards per part-file when splitting (media cap stays fixed).
    cardsPerFile = DEFAULT_ANKI_CARDS_PER_FILE,
    options: AnkiRenderOptions = {}
  ): AnkiRenderedDeck[] {
    const pins = options.pins ?? new Map<string, string>();
    const noteCards = new Map<number, AnkiParsedCard[]>();
    for (const card of cards) {
      const group = noteCards.get(card.noteId);
      if (group) group.push(card);
      else noteCards.set(card.noteId, [card]);
    }
    const context = (): RenderContext => ({ bindings: [], pins, noteCards });

    // Ids first: a basic or template card's id never depends on its front.
    const fronted = cards
      .filter((card) => card.kind === "basic" || card.kind === "template")
      .sort((a, b) => a.noteId - b.noteId || a.ord - b.ord || a.cardId - b.cardId);
    const idContext = context();
    for (const card of fronted) AnkiDeckRenderer.basicId(idContext, card);
    AnkiDeckRenderer.keepEarlierFronts(fronted, options.earlierRows ?? []);
    AnkiDeckRenderer.disambiguateFronts(fronted);

    const byDeck = new Map<string, AnkiParsedCard[]>();
    for (const card of cards) {
      const group = byDeck.get(card.deckName);
      if (group) group.push(card);
      else byDeck.set(card.deckName, [card]);
    }

    const decks: AnkiRenderedDeck[] = [];
    for (const [deckName, deckCards] of byDeck) {
      const tag = AnkiDeckRenderer.deckTag(baseTag, deckName);
      // When splitting, the chunker returns a single chunk if the deck fits both
      // caps (output unchanged), else multiple subfoldered parts so each file stays
      // openable in Obsidian — capped on card count AND media embeds, since a file
      // with thousands of audio/image embeds lags reading view even under the card
      // cap. When not splitting, the whole deck is kept as one file.
      const chunks = split
        ? AnkiDeckRenderer.chunkByNote(deckCards, cardsPerFile, MEDIA_PER_FILE)
        : [deckCards];
      if (chunks.length === 1) {
        const ctx = context();
        decks.push({
          deckName,
          relativePath: AnkiDeckRenderer.deckPath(deckName),
          tag,
          content: AnkiDeckRenderer.renderFile(deckCards, baseTag, deckName, headerLevel, ctx),
          cards: deckCards,
          bindings: ctx.bindings,
        });
        continue;
      }
      const width = Math.max(2, String(chunks.length).length);
      const path = AnkiDeckRenderer.deckPath(deckName);
      const leaf = AnkiDeckRenderer.leafLabel(deckName);
      chunks.forEach((chunkCards, i) => {
        const nn = String(i + 1).padStart(width, "0");
        const ctx = context();
        decks.push({
          deckName,
          relativePath: `${path}/${leaf} ${nn}`,
          tag,
          content: AnkiDeckRenderer.renderFile(chunkCards, baseTag, deckName, headerLevel, ctx),
          cards: chunkCards,
          bindings: ctx.bindings,
        });
      });
    }
    return decks.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /**
   * Keep a " (n)" front an earlier import wrote: by the card's id, else (an unpinned row) the
   * next row of its deck file with that base front and back, in the order numbers were given.
   */
  private static keepEarlierFronts(cards: AnkiParsedCard[], earlier: readonly AnkiEarlierRow[]): void {
    const norm = (text: string): string => text.replace(/\s+/g, " ").trim();
    const numbered = (front: string): { base: string; n: number } => {
      const match = SUFFIXED_FRONT.exec(front);
      return match && Number(match[2]) >= 2
        ? { base: norm(match[1]), n: Number(match[2]) }
        : { base: norm(front), n: 1 };
    };
    // The back the note shows: an empty answer is written as its notes.
    const answer = (card: AnkiParsedCard): string =>
      card.kind === "basic" && !card.back.trim() ? card.notes : card.back;
    const keptByDeck = new Map<string, Set<string>>();
    const keep = (card: AnkiParsedCard, front: string): void => {
      const kept = keptByDeck.get(card.deckName) ?? new Set<string>();
      keptByDeck.set(card.deckName, kept);
      // Two cards can't both keep one front in a deck; the later one is numbered afresh.
      if (kept.has(front)) return;
      kept.add(front);
      AnkiDeckRenderer.applyFront(card, front);
    };

    const byId = new Map(earlier.map((row) => [row.id, row]));
    const cardIds = new Set(cards.map((card) => card.decksId));
    const unmatched: AnkiParsedCard[] = [];
    for (const card of cards) {
      const row = card.decksId ? byId.get(card.decksId) : undefined;
      if (!row) unmatched.push(card);
      else if (numbered(row.front).n >= 2 && numbered(row.front).base === norm(card.front)) keep(card, row.front);
    }

    // Rows no card owns, by base front and back; bare ones count as number 1.
    const spare = new Map<string, Array<{ row: AnkiEarlierRow; n: number }>>();
    for (const row of earlier) {
      if (cardIds.has(row.id)) continue;
      const { base, n } = numbered(row.front);
      const key = `${base}\u0000${norm(row.back)}`;
      const queue = spare.get(key) ?? [];
      queue.push({ row, n });
      spare.set(key, queue);
    }
    for (const queue of spare.values()) queue.sort((a, b) => a.n - b.n);
    for (const card of unmatched) {
      const queue = spare.get(`${norm(card.front)}\u0000${norm(answer(card))}`);
      const at = queue?.findIndex(({ row }) => AnkiDeckRenderer.inDeckFile(row.path, card.deckName)) ?? -1;
      if (!queue || at < 0) continue;
      const [{ row, n }] = queue.splice(at, 1);
      if (n >= 2) keep(card, row.front);
    }
  }

  // Whether a deck file (relative, no ".md") is this deck's note or one of its part-files.
  private static inDeckFile(path: string, deckName: string): boolean {
    const deck = AnkiDeckRenderer.deckPath(deckName);
    const part = `${deck}/${AnkiDeckRenderer.leafLabel(deckName)} `;
    return path === deck || (path.startsWith(part) && /^\d+$/.test(path.slice(part.length)));
  }

  // Same-front cards within one Anki deck get " (n)": editors and open-in-note still find a
  // card by its front. Across decks the ids in the tokens keep them apart.
  private static disambiguateFronts(cards: AnkiParsedCard[]): void {
    const groups = new Map<string, AnkiParsedCard[]>();
    const usedByDeck = new Map<string, Set<string>>();
    for (const card of cards) {
      const front = card.front.trim();
      const key = `${card.deckName}\u0000${front}`;
      const group = groups.get(key);
      if (group) group.push(card);
      else groups.set(key, [card]);
      const used = usedByDeck.get(card.deckName);
      if (used) used.add(front);
      else usedByDeck.set(card.deckName, new Set([front]));
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const base = group[0].front.trim();
      const used = usedByDeck.get(group[0].deckName)!;
      let n = 2;
      for (let i = 1; i < group.length; i++) {
        let candidate = `${base} (${n})`;
        while (used.has(candidate)) candidate = `${base} (${++n})`;
        used.add(candidate);
        n++;
        AnkiDeckRenderer.applyFront(group[i], candidate);
      }
    }
  }

  // A template card's id hashes `front` while its table renders `cells[0]`, and the
  // two are the same value (parser sets `front = cells[0]`); keep them in lockstep.
  private static applyFront(card: AnkiParsedCard, front: string): void {
    card.front = front;
    if (card.templateRow) {
      card.templateRow.cells = [front, ...card.templateRow.cells.slice(1)];
    }
  }

  // Split a deck's cards into chunks capped by both card count and media-embed
  // count (whichever is hit first), WITHOUT ever splitting a note (all cards of a
  // note must share one file → one deckId → consistent history ids). Note-groups
  // are ordered by their smallest cardId so chunk membership is deterministic
  // regardless of the parser's row order (re-imports stay stable). A single
  // note-group that alone exceeds a cap forms its own chunk.
  private static chunkByNote(
    cards: AnkiParsedCard[],
    cardCap: number,
    mediaCap: number
  ): AnkiParsedCard[][] {
    const byNote = new Map<number, AnkiParsedCard[]>();
    for (const card of cards) {
      const group = byNote.get(card.noteId);
      if (group) group.push(card);
      else byNote.set(card.noteId, [card]);
    }
    const groups = [...byNote.values()].sort(
      (a, b) =>
        Math.min(...a.map((c) => c.cardId)) - Math.min(...b.map((c) => c.cardId))
    );
    const mediaCount = (group: AnkiParsedCard[]): number =>
      group.reduce((sum, c) => sum + c.media.length, 0);

    const chunks: AnkiParsedCard[][] = [];
    let current: AnkiParsedCard[] = [];
    let currentMedia = 0;
    for (const group of groups) {
      const groupMedia = mediaCount(group);
      if (
        current.length > 0 &&
        (current.length + group.length > cardCap || currentMedia + groupMedia > mediaCap)
      ) {
        chunks.push(current);
        current = [];
        currentMedia = 0;
      }
      current.push(...group);
      currentMedia += groupMedia;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  /** The value earlier imports minted for a card's token, which their bindings are keyed on. */
  static legacyAnchorValue(noteId: number, ord: number): string {
    return generateAnchorId(`anki:${noteId}:${ord}`);
  }

  /** A card's id: the one an earlier import pinned, else a 64-bit id from its Anki note and slot. */
  private static importedId(
    ctx: RenderContext,
    prefix: "card_" | "ccard_",
    noteId: number,
    slot: string,
    legacyKeys: string[]
  ): string {
    for (const key of legacyKeys) {
      const pinned = ctx.pins.get(key);
      if (pinned) return pinned;
    }
    return `${prefix}${hash64(`anki:${noteId}:${slot}`)}`;
  }

  /** The token for a host carrying `ids`, recording a binding row per card. */
  private static token(
    ctx: RenderContext,
    role: AnchorRole,
    kind: "a" | "p",
    ids: string[]
  ): string {
    const value = encodeAnchorValue(kind, ids);
    if (value === null) return "";
    ids.forEach((id, k) => {
      ctx.bindings.push({ anchor: kind === "p" ? `${role}:${value}#${k}` : `${role}:${value}`, flashcardId: id });
    });
    return formatAnchorToken(role, value);
  }

  /** The id a basic or template card is written with. */
  private static basicId(ctx: RenderContext, card: AnkiParsedCard): string {
    const legacy = AnkiDeckRenderer.legacyAnchorValue(card.noteId, card.ord);
    card.decksId = AnkiDeckRenderer.importedId(ctx, "card_", card.noteId, String(card.ord), [
      `h:${legacy}`,
      `t:${legacy}`,
    ]);
    return card.decksId;
  }

  /** One id per deletion of a cloze note, handed to each of the note's parsed cards. */
  private static clozeIds(ctx: RenderContext, card: AnkiParsedCard, source: string): string[] {
    const siblings = ctx.noteCards.get(card.noteId) ?? [card];
    const legacyValues = siblings.map((c) => AnkiDeckRenderer.legacyAnchorValue(c.noteId, c.ord));
    const ids = scanClozeDeletions(source).map((_, order) =>
      AnkiDeckRenderer.importedId(
        ctx,
        "ccard_",
        card.noteId,
        `c${order}`,
        legacyValues.flatMap((v) => [`t:${v}#${order}`, `c:${v}#${order}`])
      )
    );
    for (const sibling of siblings) {
      const order = sibling.clozeOrder ?? sibling.ord;
      if (order < ids.length) sibling.decksId = ids[order];
    }
    return ids;
  }

  /**
   * The Decks card id an imported card resolves to on sync — the single
   * source both the emitted tokens and the history importer key to.
   */
  static decksCardId(card: AnkiParsedCard): string {
    if (card.decksId) return card.decksId;
    if (card.kind === "occlusion" && card.maskId) {
      return generateOcclusionV2FlashcardId(
        AnkiDeckRenderer.leafLabel(card.deckName),
        occlusionImageName(card.imagePath ?? ""),
        card.maskId
      );
    }
    if (card.isCloze) {
      const full = (card.clozeBody ?? card.back).trim();
      const split = splitClozeHeader(full);
      const front = split ? split.header : full;
      return generateClozeFlashcardId(
        front,
        card.clozeText ?? "",
        card.clozeOrder ?? card.ord
      );
    }
    return generateFlashcardId(card.front);
  }

  private static renderFile(
    cards: AnkiParsedCard[],
    baseTag: string,
    deckName: string,
    headerLevel: number,
    ctx: RenderContext
  ): string {
    const level = Math.min(6, Math.max(1, headerLevel || 2));
    const tag = AnkiDeckRenderer.deckTag(baseTag, deckName);
    const frontmatter = ["---", "tags:", `  - ${tag}`, "---", ""].join("\n");

    const basic = cards.filter((c) => c.kind === "basic");
    const clozeCards = cards.filter((c) => c.kind === "cloze");
    const templateCards = cards.filter((c) => c.kind === "template");
    const occlusionCards = cards.filter((c) => c.kind === "occlusion");

    // Basic cards default to header-paragraph; those that fit escalate to a table.
    let tableBasic = basic.filter((c) => c.tableLayout);
    let hpBasic = basic.filter((c) => !c.tableLayout);
    // Volume fallback: a deck dominated by header-paragraph cards becomes an
    // unwieldy wall of sections — collapse them all into the aggregated table
    // (even non-compact ones; they flatten with <br>). Cards with an empty back or
    // block markdown (tables/lists) stay header-paragraph — they can't be a cell.
    if (hpBasic.length >= HEADER_PARAGRAPH_TABLE_THRESHOLD) {
      const promotable = (c: AnkiParsedCard): boolean =>
        c.back.trim().length > 0 && !hasBlockMarkdown(`${c.back}\n${c.notes}`);
      tableBasic = [...tableBasic, ...hpBasic.filter(promotable)];
      hpBasic = hpBasic.filter((c) => !promotable(c));
    }

    const sections = [
      ...AnkiDeckRenderer.renderTableSections(tableBasic, deckName, level, ctx),
      ...AnkiDeckRenderer.renderHeaderParagraphSections(hpBasic, level, ctx),
      ...AnkiDeckRenderer.renderClozeSections(clozeCards, deckName, level, ctx),
      ...AnkiDeckRenderer.renderTemplateSections(templateCards, deckName, level, ctx),
      ...AnkiDeckRenderer.renderOcclusionSections(occlusionCards, deckName, level),
    ];

    // Order sections by tag (untagged first), then header A–Z. Stable + accent/
    // case-insensitive + natural numeric so "Card 2" precedes "Card 10".
    sections.sort(
      (a, b) =>
        a.sortTag.localeCompare(b.sortTag) ||
        a.sortHeader.localeCompare(b.sortHeader, undefined, { sensitivity: "base", numeric: true })
    );

    return frontmatter + sections.map((s) => s.content).join("\n\n") + "\n";
  }

  // Cloze cards: one table per (deck, cloze-model tag). With extras → a tag-bound
  // table whose columns are the cloze field + extra fields (cloze in column 0);
  // pure cloze (no template) → a 1-col `| Front |` table (cell = the sentence).
  // Aggregated per note (dedup by note).
  private static renderClozeSections(
    cards: AnkiParsedCard[],
    deckName: string,
    level: number,
    ctx: RenderContext
  ): RenderedSection[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);
    const deduped = AnkiDeckRenderer.dedupeClozeByNote(cards);

    const tagged = new Map<string, AnkiParsedCard[]>();
    const plain: AnkiParsedCard[] = [];
    for (const card of deduped) {
      if (card.templateRow && card.templateTag) {
        const group = tagged.get(card.templateTag);
        if (group) group.push(card);
        else tagged.set(card.templateTag, [card]);
      } else {
        plain.push(card);
      }
    }

    const sections: RenderedSection[] = [];
    for (const [tag, group] of tagged) {
      for (const { tags, cards: sub } of AnkiDeckRenderer.partitionByTags(group)) {
        const headers = sub[0].templateRow?.headers ?? [];
        const headerRow = `| ${headers.map((h) => escapeTableCell(h)).join(" | ")} |`;
        const separator = `| ${headers.map(() => "---").join(" | ")} |`;
        const rows = sub.map(
          (c) => `| ${(c.templateRow?.cells ?? []).map((cell) => escapeTableCell(cleanCell(cell))).join(" | ")} |`
        );
        sections.push(
          AnkiDeckRenderer.section(
            tags,
            label,
            `${hashes} ${label} #${tag}${AnkiDeckRenderer.tagSuffix(tags)}\n\n${headerRow}\n${separator}\n${rows.join("\n")}`
          )
        );
      }
    }

    // Multi-paragraph/long clozes with a plain title line render as header-
    // paragraph (newlines preserved); the rest aggregate into a 1-col table.
    const tablePlain: AnkiParsedCard[] = [];
    for (const card of plain) {
      const split = splitClozeHeader(card.clozeBody ?? card.back);
      if (split) {
        const body = AnkiDeckRenderer.tokenizeClozeBody(card, split.body, ctx);
        sections.push(
          AnkiDeckRenderer.section(
            card.tags,
            split.header,
            `${hashes} ${split.header}${AnkiDeckRenderer.tagSuffix(card.tags)}\n\n${body}`
          )
        );
      } else {
        tablePlain.push(card);
      }
    }
    for (const { tags, cards: sub } of AnkiDeckRenderer.partitionByTags(tablePlain)) {
      const rows = sub.map((c) => {
        // The parser reads the deletions from the cell as written.
        const cell = cleanCell(c.clozeBody ?? c.back);
        const token = AnkiDeckRenderer.token(ctx, "t", "p", AnkiDeckRenderer.clozeIds(ctx, c, cell));
        return `| ${escapeTableCell(cell)} ${token} |`;
      });
      sections.push(
        AnkiDeckRenderer.section(
          tags,
          label,
          `${hashes} ${label}${AnkiDeckRenderer.tagSuffix(tags)}\n\n| Front |\n| --- |\n${rows.join("\n")}`
        )
      );
    }
    return sections;
  }

  /**
   * Header-hosted cloze: token the line carrying the deletions, only when one body
   * line holds them all. Multi-line cloze bodies keep content ids and stamp at review.
   */
  private static tokenizeClozeBody(card: AnkiParsedCard, body: string, ctx: RenderContext): string {
    const lines = body.split("\n");
    const markLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => scanClozeDeletions(line).length > 0);
    if (markLines.length !== 1) return body;

    const target = markLines[0];
    const token = AnkiDeckRenderer.token(ctx, "c", "p", AnkiDeckRenderer.clozeIds(ctx, card, target.line));
    lines[target.index] = `${target.line} ${token}`;
    return lines.join("\n");
  }

  // Multi-field cards: one markdown table per binding tag, header row = field
  // names, each row = the card's cells. A tag on the `## …` header binds the
  // per-model template that merges these cells at render time.
  private static renderTemplateSections(
    cards: AnkiParsedCard[],
    deckName: string,
    level: number,
    ctx: RenderContext
  ): RenderedSection[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);
    const byTag = new Map<string, AnkiParsedCard[]>();
    for (const card of cards) {
      if (!card.templateRow || !card.templateTag) continue;
      const group = byTag.get(card.templateTag);
      if (group) group.push(card);
      else byTag.set(card.templateTag, [card]);
    }

    const sections: RenderedSection[] = [];
    for (const [tag, group] of byTag) {
      for (const { tags, cards: sub } of AnkiDeckRenderer.partitionByTags(group)) {
        const headers = sub[0].templateRow?.headers ?? [];
        const headerRow = `| ${headers.map((h) => escapeTableCell(h)).join(" | ")} |`;
        const separator = `| ${headers.map(() => "---").join(" | ")} |`;
        const rows = sub.map((c) => {
          const cellsOut = (c.templateRow?.cells ?? []).map((cell) =>
            escapeTableCell(cleanCell(cell))
          );
          if (cellsOut.length > 0) {
            const token = AnkiDeckRenderer.token(ctx, "t", "a", [AnkiDeckRenderer.basicId(ctx, c)]);
            cellsOut[0] = `${cellsOut[0]} ${token}`;
          }
          return `| ${cellsOut.join(" | ")} |`;
        });
        sections.push(
          AnkiDeckRenderer.section(
            tags,
            label,
            `${hashes} ${label} #${tag}${AnkiDeckRenderer.tagSuffix(tags)}\n\n${headerRow}\n${separator}\n${rows.join("\n")}`
          )
        );
      }
    }
    return sections;
  }

  // Occlusion cards: one `decks-occlusion` codeblock per base image (all masks).
  private static renderOcclusionSections(cards: AnkiParsedCard[], deckName: string, level: number): RenderedSection[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);
    const byImage = new Map<string, AnkiParsedCard>();
    for (const card of cards) {
      if (!card.imagePath || !card.masks) continue;
      if (!byImage.has(card.imagePath)) byImage.set(card.imagePath, card);
    }

    const sections: RenderedSection[] = [];
    for (const card of byImage.values()) {
      const yaml = OcclusionV2Parser.toYaml({
        __v: OCCLUSION_V2_VERSION,
        image: card.imageRef ?? `[[${card.imagePath}]]`,
        masks: card.masks ?? [],
      }).trimEnd();
      sections.push(
        AnkiDeckRenderer.section(
          card.tags,
          label,
          `${hashes} ${label}${AnkiDeckRenderer.tagSuffix(card.tags)}\n\n\`\`\`decks-occlusion\n${yaml}\n\`\`\``
        )
      );
    }
    return sections;
  }

  private static renderHeaderParagraphSections(
    cards: AnkiParsedCard[],
    level: number,
    ctx: RenderContext
  ): RenderedSection[] {
    const hashes = "#".repeat(level);
    const sections: RenderedSection[] = [];
    for (const card of cards) {
      const front = card.front.trim() || `Card ${card.noteId}-${card.ord}`;
      // An empty back with notes present would leave a dangling `---`; promote.
      let back = card.back.trim();
      let notes = card.notes.trim();
      if (!back && notes) {
        back = notes;
        notes = "";
      }
      const token = AnkiDeckRenderer.token(ctx, "h", "a", [AnkiDeckRenderer.basicId(ctx, card)]);
      const body = notes
        ? `${back}\n${token}\n\n---\n\n${notes}`
        : `${back}\n${token}`;
      sections.push(
        AnkiDeckRenderer.section(card.tags, front, `${hashes} ${front}${AnkiDeckRenderer.tagSuffix(card.tags)}\n\n${body}`)
      );
    }
    return sections;
  }

  // Basic cards routed to a table aggregate into a single table per column
  // structure: one 2-col `| Front | Back |` table for cards without notes and one
  // 3-col `| Front | Back | Notes |` table for cards with notes (no padded rows).
  private static renderTableSections(
    cards: AnkiParsedCard[],
    deckName: string,
    level: number,
    ctx: RenderContext
  ): RenderedSection[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);

    const tableToken = (c: AnkiParsedCard): string =>
      ` ${AnkiDeckRenderer.token(ctx, "t", "a", [AnkiDeckRenderer.basicId(ctx, c)])}`;

    const sections: RenderedSection[] = [];
    for (const { tags, cards: group } of AnkiDeckRenderer.partitionByTags(cards)) {
      const suffix = AnkiDeckRenderer.tagSuffix(tags);
      const withoutNotes = group.filter((c) => !c.notes.trim());
      const withNotes = group.filter((c) => c.notes.trim().length > 0);
      if (withoutNotes.length > 0) {
        const rows = withoutNotes.map(
          (c) => `| ${escapeTableCell(cleanCell(c.front))}${tableToken(c)} | ${escapeTableCell(cleanCell(c.back))} |`
        );
        sections.push(
          AnkiDeckRenderer.section(
            tags,
            label,
            `${hashes} ${label}${suffix}\n\n| Front | Back |\n| --- | --- |\n${rows.join("\n")}`
          )
        );
      }
      if (withNotes.length > 0) {
        const rows = withNotes.map(
          (c) =>
            `| ${escapeTableCell(cleanCell(c.front))}${tableToken(c)} | ${escapeTableCell(cleanCell(c.back))} | ${escapeTableCell(cleanCell(c.notes))} |`
        );
        sections.push(
          AnkiDeckRenderer.section(
            tags,
            label,
            `${hashes} ${label}${suffix}\n\n| Front | Back | Notes |\n| --- | --- | --- |\n${rows.join("\n")}`
          )
        );
      }
    }
    return sections;
  }

  // Build a section carrying its sort keys: tag-set (note tags, "" when untagged)
  // then the header text. renderFile sorts by these before joining.
  private static section(tags: string[] | undefined, header: string, content: string): RenderedSection {
    return { sortTag: AnkiDeckRenderer.sortedTags(tags).join(" "), sortHeader: header, content };
  }

  // Sorted, de-duped Obsidian tags for a card (no leading #).
  private static sortedTags(tags?: string[]): string[] {
    return tags && tags.length ? [...new Set(tags)].sort() : [];
  }

  // A trailing ` #a #b` suffix for a section/card header (empty when no tags).
  private static tagSuffix(tags?: string[]): string {
    const sorted = AnkiDeckRenderer.sortedTags(tags);
    return sorted.length ? " " + sorted.map((t) => `#${t}`).join(" ") : "";
  }

  // Partition cards by their tag-set so each set gets its own section/table whose
  // header carries those tags (cards under a header inherit its tags in Decks).
  private static partitionByTags(
    cards: AnkiParsedCard[]
  ): Array<{ tags: string[]; cards: AnkiParsedCard[] }> {
    const groups = new Map<string, { tags: string[]; cards: AnkiParsedCard[] }>();
    for (const card of cards) {
      const tags = AnkiDeckRenderer.sortedTags(card.tags);
      const key = tags.join("|");
      const group = groups.get(key);
      if (group) group.cards.push(card);
      else groups.set(key, { tags, cards: [card] });
    }
    return [...groups.values()];
  }

  private static dedupeClozeByNote(cards: AnkiParsedCard[]): AnkiParsedCard[] {
    const seen = new Set<number>();
    const result: AnkiParsedCard[] = [];
    for (const card of cards) {
      if (!card.isCloze) continue;
      if (seen.has(card.noteId)) continue;
      seen.add(card.noteId);
      result.push(card);
    }
    return result;
  }

  // The deck's own (leaf) name, cleaned for use as a table's container header.
  static leafLabel(deckName: string): string {
    const segments = deckName.split("::");
    const leaf = segments[segments.length - 1] ?? deckName;
    return leaf.replace(ILLEGAL_PATH, " ").replace(/\s+/g, " ").trim() || "Cards";
  }

  // "Parent::Child" → "Parent/Child" with each segment cleaned for a vault path.
  private static deckPath(deckName: string): string {
    return deckName
      .split("::")
      .map((segment) => segment.replace(ILLEGAL_PATH, " ").replace(/\s+/g, " ").trim())
      .filter((segment) => segment.length > 0)
      .join("/");
  }

  // baseTag + a slugified hierarchy ("decks/anki/parent/child").
  private static deckTag(baseTag: string, deckName: string): string {
    const base = baseTag.replace(/^#/, "").replace(/\/+$/, "");
    const slug = deckName
      .split("::")
      .map((segment) => AnkiDeckRenderer.slugify(segment))
      .filter((segment) => segment.length > 0)
      .join("/");
    return slug ? `${base}/${slug}` : base;
  }

  private static slugify(segment: string): string {
    return segment
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
