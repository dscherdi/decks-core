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
} from "../../../utils/hash";
import {
  clozeBindingKey,
  formatAnchorToken,
  headerBindingKey,
  tableBindingKey,
} from "../../../utils/anchors";
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
  // Anchor bindings for the tokens emitted into `content`, keyed to the same
  // card ids the history importer uses — re-imports reproduce identical
  // tokens/bindings, so recipients keep their progress across deck updates.
  bindings: AnkiAnchorBinding[];
}

const ANKI_CLOZE_MARK_REGEX = /==((?:(?!==).)+)==/g;

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
    // Fronts already taken elsewhere in the vault (other live decks). An imported
    // card whose front is reserved gets a " (n)" suffix so it lands as its own
    // card instead of silently merging into the other deck's card.
    reservedFronts?: ReadonlySet<string>
  ): AnkiRenderedDeck[] {
    AnkiDeckRenderer.disambiguateFronts(cards, reservedFronts);

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
        const bindings: AnkiAnchorBinding[] = [];
        decks.push({
          deckName,
          relativePath: AnkiDeckRenderer.deckPath(deckName),
          tag,
          content: AnkiDeckRenderer.renderFile(deckCards, baseTag, deckName, headerLevel, bindings),
          cards: deckCards,
          bindings,
        });
        continue;
      }
      const width = Math.max(2, String(chunks.length).length);
      const path = AnkiDeckRenderer.deckPath(deckName);
      const leaf = AnkiDeckRenderer.leafLabel(deckName);
      chunks.forEach((chunkCards, i) => {
        const nn = String(i + 1).padStart(width, "0");
        const bindings: AnkiAnchorBinding[] = [];
        decks.push({
          deckName,
          relativePath: `${path}/${leaf} ${nn}`,
          tag,
          content: AnkiDeckRenderer.renderFile(chunkCards, baseTag, deckName, headerLevel, bindings),
          cards: chunkCards,
          bindings,
        });
      });
    }
    return decks.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  // Card ids are derived from the front text and are deck-independent, so two
  // notes that render the same front (e.g. the same head-word in several
  // sub-decks) would collapse to a single card on sync. Append a stable " (n)"
  // marker to every occurrence after the first so each keeps a distinct front —
  // and therefore a distinct id. When a front is RESERVED (already taken by a
  // card in another live deck of the vault), every occurrence is suffixed, so the
  // imported card lands as its own card instead of being silently dropped in
  // favour of the other deck's. Only basic/template cards key their id on the
  // front (cloze/occlusion key on cloze text/order or mask id, so they're left
  // untouched). Ordering is by (noteId, ord, cardId) — never the parser's row
  // order, which is unsorted — so re-imports are byte-stable.
  private static disambiguateFronts(
    cards: AnkiParsedCard[],
    reservedFronts?: ReadonlySet<string>
  ): void {
    const groups = new Map<string, AnkiParsedCard[]>();
    for (const card of cards) {
      if (card.kind !== "basic" && card.kind !== "template") continue;
      const key = card.front.trim();
      const group = groups.get(key);
      if (group) group.push(card);
      else groups.set(key, [card]);
    }

    const reservedTrimmed = new Set<string>();
    if (reservedFronts) for (const front of reservedFronts) reservedTrimmed.add(front.trim());

    // Seed with every real front (batch + reserved) so a synthesized "word (2)"
    // never collides with a note or vault card whose front already is "word (2)".
    const used = new Set(groups.keys());
    for (const front of reservedTrimmed) used.add(front);
    for (const [key, group] of groups) {
      const reserved = reservedTrimmed.has(key);
      if (group.length < 2 && !reserved) continue;
      group.sort((a, b) => a.noteId - b.noteId || a.ord - b.ord || a.cardId - b.cardId);
      let n = 2;
      for (let i = reserved ? 0 : 1; i < group.length; i++) {
        let candidate = `${key} (${n})`;
        while (used.has(candidate)) candidate = `${key} (${++n})`;
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

  /**
   * Deterministic anchor-token id for an imported card: keyed on the Anki
   * noteId/ord, so a re-import reproduces byte-identical tokens.
   */
  static cardAnchorId(card: AnkiParsedCard): string {
    return generateAnchorId(`anki:${card.noteId}:${card.ord}`);
  }

  /**
   * The Decks card id an imported card resolves to on sync — the single
   * source both the emitted anchor bindings and the history importer key to.
   */
  static decksCardId(card: AnkiParsedCard): string {
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
    bindings: AnkiAnchorBinding[]
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
      ...AnkiDeckRenderer.renderTableSections(tableBasic, deckName, level, bindings),
      ...AnkiDeckRenderer.renderHeaderParagraphSections(hpBasic, level, bindings),
      ...AnkiDeckRenderer.renderClozeSections(clozeCards, deckName, level, bindings),
      ...AnkiDeckRenderer.renderTemplateSections(templateCards, deckName, level, bindings),
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
    bindings: AnkiAnchorBinding[]
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
        const body = AnkiDeckRenderer.tokenizeClozeBody(
          card,
          split.header,
          split.body,
          bindings
        );
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
        const sentence = (c.clozeBody ?? c.back).trim();
        const anchorId = AnkiDeckRenderer.cardAnchorId(c);
        AnkiDeckRenderer.bindClozeMarks(sentence, sentence, anchorId, "t", bindings);
        return `| ${escapeTableCell(cleanCell(c.clozeBody ?? c.back))} ${formatAnchorToken("t", anchorId)} |`;
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
   * Header-hosted cloze: token the line carrying the cloze marks — only when a
   * single body line holds them all, so line-scoped keys stay unambiguous.
   * Multi-line cloze bodies emit no token and anchor lazily at review time.
   */
  private static tokenizeClozeBody(
    card: AnkiParsedCard,
    front: string,
    body: string,
    bindings: AnkiAnchorBinding[]
  ): string {
    const lines = body.split("\n");
    const markLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => new RegExp(ANKI_CLOZE_MARK_REGEX.source).test(line));
    if (markLines.length !== 1) return body;

    const anchorId = AnkiDeckRenderer.cardAnchorId(card);
    const target = markLines[0];
    AnkiDeckRenderer.bindClozeMarks(target.line, front, anchorId, "c", bindings);
    lines[target.index] = `${target.line} ${formatAnchorToken("c", anchorId)}`;
    return lines.join("\n");
  }

  /** One binding per cloze mark, keyed exactly as the parser will derive. */
  private static bindClozeMarks(
    source: string,
    front: string,
    anchorId: string,
    role: "c" | "t",
    bindings: AnkiAnchorBinding[]
  ): void {
    const regex = new RegExp(ANKI_CLOZE_MARK_REGEX.source, "g");
    let match: RegExpExecArray | null;
    let order = 0;
    while ((match = regex.exec(source)) !== null) {
      bindings.push({
        anchor:
          role === "c"
            ? clozeBindingKey(anchorId, order)
            : tableBindingKey(anchorId, order),
        flashcardId: generateClozeFlashcardId(front, match[1], order),
      });
      order++;
    }
  }

  // Multi-field cards: one markdown table per binding tag, header row = field
  // names, each row = the card's cells. A tag on the `## …` header binds the
  // per-model template that merges these cells at render time.
  private static renderTemplateSections(
    cards: AnkiParsedCard[],
    deckName: string,
    level: number,
    bindings: AnkiAnchorBinding[]
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
            const anchorId = AnkiDeckRenderer.cardAnchorId(c);
            bindings.push({
              anchor: tableBindingKey(anchorId),
              flashcardId: AnkiDeckRenderer.decksCardId(c),
            });
            cellsOut[0] = `${cellsOut[0]} ${formatAnchorToken("t", anchorId)}`;
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
    bindings: AnkiAnchorBinding[]
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
      const anchorId = AnkiDeckRenderer.cardAnchorId(card);
      const token = formatAnchorToken("h", anchorId);
      bindings.push({
        anchor: headerBindingKey(anchorId),
        flashcardId: AnkiDeckRenderer.decksCardId(card),
      });
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
    bindings: AnkiAnchorBinding[]
  ): RenderedSection[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);

    const tableToken = (c: AnkiParsedCard): string => {
      const anchorId = AnkiDeckRenderer.cardAnchorId(c);
      bindings.push({
        anchor: tableBindingKey(anchorId),
        flashcardId: AnkiDeckRenderer.decksCardId(c),
      });
      return ` ${formatAnchorToken("t", anchorId)}`;
    };

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
