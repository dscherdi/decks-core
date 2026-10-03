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

/** How a card's source page reads in the vault — the same shape the source
 *  labels use. */
export function sourcePageNote(page: number): string {
  return `p. ${page}`;
}

/** The card's notes with its source page appended. Provenance rides notes as
 *  the one channel every save format carries. */
export function withSourcePage(card: GeneratedCard): GeneratedCard {
  if (!card.page) return card;
  const note = sourcePageNote(card.page);
  const existing = card.notes.trim();
  return { ...card, notes: existing ? `${existing}\n\n${note}` : note };
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
  // The page rides a comment, as on questions: a note to the parser, hidden when read.
  if (card.page) block += `\n\n%%${sourcePageNote(card.page)}%%`;
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
 * is included only when at least one card has notes, unless `notesColumn` asks
 * for it always — for a table later rows will join. Cells escape `|`/newlines.
 */
export function buildTableContent(
  cards: GeneratedCard[],
  level: number,
  sectionTitle: string,
  options: { notesColumn?: "auto" | "always" } = {},
): string {
  const stamped = cards.map(withSourcePage);
  const withNotes =
    options.notesColumn === "always" ||
    stamped.some((c) => c.notes.trim() !== "");
  const header = withNotes ? "| Front | Back | Notes |" : "| Front | Back |";
  const sep = withNotes ? "| --- | --- | --- |" : "| --- | --- |";
  const rows = stamped.map((c) => {
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
