import { hasBlockMarkdown } from "../../../utils/markdown-table";

// Mirror the compactness caps used for table cells.
const MAX_CELL_CHARS = 300;
const MAX_CELL_LINES = 4;

/**
 * Decide how a pure-cloze sentence renders. A compact sentence stays a 1-col
 * table cell; a multi-paragraph/long one becomes header-paragraph — but only
 * when its first line carries no `==highlight==`, so that line can serve as a
 * plain header. Returns the `{ header, body }` split, or `null` to keep the
 * compact table layout.
 *
 * Shared by the renderer (to emit the markdown) and the history importer (to
 * reproduce the front the parser will hash for the card id).
 */
export function splitClozeHeader(text: string): { header: string; body: string } | null {
  const trimmed = text.trim();
  const compact =
    trimmed.length <= MAX_CELL_CHARS &&
    trimmed.split("\n").length <= MAX_CELL_LINES &&
    !/\n[ \t]*\n/.test(trimmed) &&
    !hasBlockMarkdown(trimmed);
  if (compact) return null;

  const nl = trimmed.indexOf("\n");
  const header = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
  if (!header || header.includes("==")) return null;
  const body = nl === -1 ? "" : trimmed.slice(nl + 1).trim();
  if (!body) return null;
  return { header, body };
}
