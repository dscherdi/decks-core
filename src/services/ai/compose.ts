import { escapeTableCell } from "../../utils/markdown-table";
import type { GeneratedCard } from "./generation-prompt";

/**
 * Rendering generated cards back into the markdown Decks parses. Pure string
 * work, so both the plugin (which then writes through the vault) and the mobile
 * app can share one definition of what a saved card looks like.
 */

/** Convert a profile header level to `#` chars (level 0/out-of-range → `#`). */
export function headingHashes(level: number): string {
  const n = level >= 1 && level <= 6 ? level : 1;
  return "#".repeat(n);
}

/** Collapse a front to a single heading line. */
function headingLine(front: string, level: number): string {
  return `${headingHashes(level)} ${front.trim().replace(/\n+/g, " ")}`;
}

/**
 * One header+paragraph block: heading + body, with notes appended as a trailing
 * paragraph when present (header-paragraph cards have no separate notes field).
 */
export function buildHeaderParagraphCard(
  card: GeneratedCard,
  level: number,
): string {
  let block = `${headingLine(card.front, level)}\n\n${card.back.trim()}`;
  // Notes are written after a thematic-break delimiter so the parser recovers
  // them as the card's notes field (see FlashcardParser.extractHeaderParagraphNotes).
  if (card.notes.trim()) block += `\n\n---\n\n${card.notes.trim()}`;
  return block;
}

/** Full header+paragraph document body for a list of cards. */
export function buildHeaderParagraphContent(
  cards: GeneratedCard[],
  level: number,
): string {
  return cards.map((c) => buildHeaderParagraphCard(c, level)).join("\n\n");
}

/**
 * A table section: one heading then a Front/Back(/Notes) table. The Notes column
 * is included only when at least one card has notes. Cells escape `|`/newlines.
 */
export function buildTableContent(
  cards: GeneratedCard[],
  level: number,
  sectionTitle: string,
): string {
  const withNotes = cards.some((c) => c.notes.trim() !== "");
  const header = withNotes ? "| Front | Back | Notes |" : "| Front | Back |";
  const sep = withNotes ? "| --- | --- | --- |" : "| --- | --- |";
  const rows = cards.map((c) => {
    const front = escapeTableCell(c.front.trim());
    const back = escapeTableCell(c.back.trim());
    return withNotes
      ? `| ${front} | ${back} | ${escapeTableCell(c.notes.trim())} |`
      : `| ${front} | ${back} |`;
  });
  return [
    `${headingHashes(level)} ${sectionTitle}`,
    "",
    header,
    sep,
    ...rows,
  ].join("\n");
}
