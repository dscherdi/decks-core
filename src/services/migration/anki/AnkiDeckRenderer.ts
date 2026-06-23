import type { AnkiParsedCard } from "./AnkiTypes";
import { escapeTableCell } from "../../../utils/markdown-table";

/** Markdown layout for the imported decks. */
export type AnkiFormat = "header-paragraph" | "table";

export interface AnkiRenderedDeck {
  deckName: string; // original Anki deck path ("Parent::Child")
  relativePath: string; // vault-relative path without extension, mirroring the hierarchy
  tag: string; // deck tag for the file's frontmatter (no leading #)
  content: string; // full markdown file content
  cards: AnkiParsedCard[]; // every card for this deck (each cloze ord kept, for history)
}

const ILLEGAL_PATH = /[\\/:*?"<>|#^[\]]/g;

/**
 * Turns parsed Anki cards into one Decks markdown file per Anki deck. Cloze notes
 * collapse to a single entry (Decks expands the `==highlights==` into per-cloze
 * cards); every other card becomes its own entry, including reverse templates.
 * Header-paragraph keeps rich/multi-line content (notes go after a `---`); table
 * is compact (2-col, 3-col when any card has notes, 1-col for cloze).
 */
export class AnkiDeckRenderer {
  /**
   * @param baseTag the migration subtag every deck tag nests under (no `#`,
   *   e.g. "decks/anki"). Profile mapping is applied to this subtag.
   * @param format markdown layout (defaults to header-paragraph).
   */
  static render(
    cards: AnkiParsedCard[],
    baseTag: string,
    headerLevel: number,
    format: AnkiFormat = "header-paragraph"
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
        content: AnkiDeckRenderer.renderFile(deckCards, baseTag, deckName, headerLevel, format),
        cards: deckCards,
      });
    }
    return decks.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private static renderFile(
    cards: AnkiParsedCard[],
    baseTag: string,
    deckName: string,
    headerLevel: number,
    format: AnkiFormat
  ): string {
    const level = Math.min(6, Math.max(1, headerLevel || 2));
    const tag = AnkiDeckRenderer.deckTag(baseTag, deckName);
    const frontmatter = ["---", "tags:", `  - ${tag}`, "---", ""].join("\n");

    const sections =
      format === "table"
        ? AnkiDeckRenderer.renderTableSections(cards, deckName, level)
        : AnkiDeckRenderer.renderHeaderParagraphSections(cards, level);

    return frontmatter + sections.join("\n\n") + "\n";
  }

  private static renderHeaderParagraphSections(cards: AnkiParsedCard[], level: number): string[] {
    const hashes = "#".repeat(level);
    const sections: string[] = [];
    const seenClozeNotes = new Set<number>();
    for (const card of cards) {
      if (card.isCloze) {
        if (seenClozeNotes.has(card.noteId)) continue;
        seenClozeNotes.add(card.noteId);
      }
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

  private static renderTableSections(
    cards: AnkiParsedCard[],
    deckName: string,
    level: number
  ): string[] {
    const hashes = "#".repeat(level);
    const label = AnkiDeckRenderer.leafLabel(deckName);

    const basic = cards.filter((c) => !c.isCloze);
    const clozeNotes = AnkiDeckRenderer.dedupeClozeByNote(cards);

    const sections: string[] = [];

    if (basic.length > 0) {
      const hasNotes = basic.some((c) => c.notes.trim().length > 0);
      const header = hasNotes ? "| Front | Back | Notes |\n| --- | --- | --- |" : "| Front | Back |\n| --- | --- |";
      const rows = basic.map((c) => {
        const front = escapeTableCell(c.front.trim());
        const back = escapeTableCell(c.back.trim());
        return hasNotes ? `| ${front} | ${back} | ${escapeTableCell(c.notes.trim())} |` : `| ${front} | ${back} |`;
      });
      sections.push(`${hashes} ${label}\n\n${header}\n${rows.join("\n")}`);
    }

    if (clozeNotes.length > 0) {
      const rows = clozeNotes.map((c) => `| ${escapeTableCell((c.clozeBody ?? c.back).trim())} |`);
      sections.push(`${hashes} ${label}\n\n| Front |\n| --- |\n${rows.join("\n")}`);
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
