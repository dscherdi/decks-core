import type { AnkiParsedCard } from "./AnkiTypes";
import { escapeTableCell } from "../../../utils/markdown-table";
import { OcclusionV2Parser } from "../../occlusion/OcclusionV2Parser";
import { OCCLUSION_V2_VERSION } from "../../occlusion/OcclusionV2.types";

export interface AnkiRenderedDeck {
  deckName: string; // original Anki deck path ("Parent::Child")
  relativePath: string; // vault-relative path without extension, mirroring the hierarchy
  tag: string; // deck tag for the file's frontmatter (no leading #)
  content: string; // full markdown file content
  cards: AnkiParsedCard[]; // every card for this deck (each cloze ord kept, for history)
}

const ILLEGAL_PATH = /[\\/:*?"<>|#^[\]]/g;

// A deck with at least this many header-paragraph basic cards collapses them all
// into the aggregated table instead of a long wall of `## …` sections.
const HEADER_PARAGRAPH_TABLE_THRESHOLD = 50;

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
    headerLevel: number
  ): AnkiRenderedDeck[] {
    const byDeck = new Map<string, AnkiParsedCard[]>();
    for (const card of cards) {
      const group = byDeck.get(card.deckName);
      if (group) group.push(card);
      else byDeck.set(card.deckName, [card]);
    }

    const decks: AnkiRenderedDeck[] = [];
    for (const [deckName, deckCards] of byDeck) {
      decks.push({
        deckName,
        relativePath: AnkiDeckRenderer.deckPath(deckName),
        tag: AnkiDeckRenderer.deckTag(baseTag, deckName),
        content: AnkiDeckRenderer.renderFile(deckCards, baseTag, deckName, headerLevel),
        cards: deckCards,
      });
    }
    return decks.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private static renderFile(
    cards: AnkiParsedCard[],
    baseTag: string,
    deckName: string,
    headerLevel: number
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
    // (even non-compact ones; they flatten with <br>). Empty-back cards stay
    // header-paragraph (a Decks table row needs a non-empty back cell).
    if (hpBasic.length >= HEADER_PARAGRAPH_TABLE_THRESHOLD) {
      tableBasic = [...tableBasic, ...hpBasic.filter((c) => c.back.trim().length > 0)];
      hpBasic = hpBasic.filter((c) => c.back.trim().length === 0);
    }

    const sections = [
      ...AnkiDeckRenderer.renderTableSections(tableBasic, deckName, level),
      ...AnkiDeckRenderer.renderHeaderParagraphSections(hpBasic, level),
      ...AnkiDeckRenderer.renderClozeSections(clozeCards, deckName, level),
      ...AnkiDeckRenderer.renderTemplateSections(templateCards, deckName, level),
      ...AnkiDeckRenderer.renderOcclusionSections(occlusionCards, deckName, level),
    ];

    return frontmatter + sections.join("\n\n") + "\n";
  }

  // Cloze cards: one table per (deck, cloze-model tag). With extras → a tag-bound
  // table whose columns are the cloze field + extra fields (cloze in column 0);
  // pure cloze (no template) → a 1-col `| Front |` table (cell = the sentence).
  // Aggregated per note (dedup by note).
  private static renderClozeSections(cards: AnkiParsedCard[], deckName: string, level: number): string[] {
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

    const sections: string[] = [];
    for (const [tag, group] of tagged) {
      const headers = group[0].templateRow?.headers ?? [];
      const headerRow = `| ${headers.map((h) => escapeTableCell(h)).join(" | ")} |`;
      const separator = `| ${headers.map(() => "---").join(" | ")} |`;
      const rows = group.map(
        (c) => `| ${(c.templateRow?.cells ?? []).map((cell) => escapeTableCell(cell)).join(" | ")} |`
      );
      sections.push(`${hashes} ${label} #${tag}\n\n${headerRow}\n${separator}\n${rows.join("\n")}`);
    }
    if (plain.length > 0) {
      const rows = plain.map((c) => `| ${escapeTableCell((c.clozeBody ?? c.back).trim())} |`);
      sections.push(`${hashes} ${label}\n\n| Front |\n| --- |\n${rows.join("\n")}`);
    }
    return sections;
  }

  // Multi-field cards: one markdown table per binding tag, header row = field
  // names, each row = the card's cells. A tag on the `## …` header binds the
  // per-model template that merges these cells at render time.
  private static renderTemplateSections(cards: AnkiParsedCard[], deckName: string, level: number): string[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);
    const byTag = new Map<string, AnkiParsedCard[]>();
    for (const card of cards) {
      if (!card.templateRow || !card.templateTag) continue;
      const group = byTag.get(card.templateTag);
      if (group) group.push(card);
      else byTag.set(card.templateTag, [card]);
    }

    const sections: string[] = [];
    for (const [tag, group] of byTag) {
      const headers = group[0].templateRow?.headers ?? [];
      const headerRow = `| ${headers.map((h) => escapeTableCell(h)).join(" | ")} |`;
      const separator = `| ${headers.map(() => "---").join(" | ")} |`;
      const rows = group.map(
        (c) => `| ${(c.templateRow?.cells ?? []).map((cell) => escapeTableCell(cell)).join(" | ")} |`
      );
      sections.push(`${hashes} ${label} #${tag}\n\n${headerRow}\n${separator}\n${rows.join("\n")}`);
    }
    return sections;
  }

  // Occlusion cards: one `decks-occlusion` codeblock per base image (all masks).
  private static renderOcclusionSections(cards: AnkiParsedCard[], deckName: string, level: number): string[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);
    const byImage = new Map<string, AnkiParsedCard>();
    for (const card of cards) {
      if (!card.imagePath || !card.masks) continue;
      if (!byImage.has(card.imagePath)) byImage.set(card.imagePath, card);
    }

    const sections: string[] = [];
    for (const card of byImage.values()) {
      const yaml = OcclusionV2Parser.toYaml({
        __v: OCCLUSION_V2_VERSION,
        image: card.imageRef ?? `[[${card.imagePath}]]`,
        masks: card.masks ?? [],
      }).trimEnd();
      sections.push(`${hashes} ${label}\n\n\`\`\`decks-occlusion\n${yaml}\n\`\`\``);
    }
    return sections;
  }

  private static renderHeaderParagraphSections(cards: AnkiParsedCard[], level: number): string[] {
    const hashes = "#".repeat(level);
    const sections: string[] = [];
    for (const card of cards) {
      const front = card.front.trim() || `Card ${card.noteId}-${card.ord}`;
      // An empty back with notes present would leave a dangling `---`; promote.
      let back = card.back.trim();
      let notes = card.notes.trim();
      if (!back && notes) {
        back = notes;
        notes = "";
      }
      const body = notes ? `${back}\n\n---\n\n${notes}` : back;
      sections.push(`${hashes} ${front}\n\n${body}`);
    }
    return sections;
  }

  // Basic cards routed to a table aggregate into a single table per column
  // structure: one 2-col `| Front | Back |` table for cards without notes and one
  // 3-col `| Front | Back | Notes |` table for cards with notes (no padded rows).
  private static renderTableSections(
    cards: AnkiParsedCard[],
    deckName: string,
    level: number
  ): string[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);

    const withoutNotes = cards.filter((c) => !c.notes.trim());
    const withNotes = cards.filter((c) => c.notes.trim().length > 0);

    const sections: string[] = [];
    if (withoutNotes.length > 0) {
      const rows = withoutNotes.map(
        (c) => `| ${escapeTableCell(c.front.trim())} | ${escapeTableCell(c.back.trim())} |`
      );
      sections.push(`${hashes} ${label}\n\n| Front | Back |\n| --- | --- |\n${rows.join("\n")}`);
    }
    if (withNotes.length > 0) {
      const rows = withNotes.map(
        (c) =>
          `| ${escapeTableCell(c.front.trim())} | ${escapeTableCell(c.back.trim())} | ${escapeTableCell(c.notes.trim())} |`
      );
      sections.push(
        `${hashes} ${label}\n\n| Front | Back | Notes |\n| --- | --- | --- |\n${rows.join("\n")}`
      );
    }
    return sections;
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
  private static leafLabel(deckName: string): string {
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
