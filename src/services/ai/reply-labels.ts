import { CARD_DELIMITER } from "./prompts";

export interface LabelLine {
  /** The label in upper case, e.g. "FRONT" or "LIST ITEM". */
  name: string;
  /** The rest of the line after the colon. */
  rest: string;
}

/** Reads a line opening one of `names` as models write it: plain, or inside bold, list, quote or heading marks. */
export function labelReader(names: readonly string[]): (line: string) => LabelLine | null {
  const alt = names.join("|");
  const plain = new RegExp(`^\\s*(${alt})\\s*:(.*)$`, "i");
  // Marks are read in upper case only, so card text is not misread as a label.
  const decorated = new RegExp(
    `^\\s*(?:(?:[-*+>]|#{1,6})\\s+)?(?:\\*\\*|__)(${alt})(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?(.*)$|^\\s*(?:[-*+>]|#{1,6})\\s+(${alt})\\s*:(.*)$`,
  );
  return (line) => {
    const p = plain.exec(line);
    if (p) return { name: p[1].toUpperCase(), rest: p[2] };
    const d = decorated.exec(line);
    if (!d) return null;
    return { name: d[1] ?? d[3], rest: d[2] ?? d[4] ?? "" };
  };
}

// The delimiter as models drift into writing it: spaced, bolded, quoted or listed.
const DELIMITER_LINE_RE = /^\s*(?:[-*+>]\s*)*(?:\*\*|__)?\s*={2,}\s*END\s*={2,}\s*(?:\*\*|__)?\s*$/i;

/** Whether a whole line is a drifted spelling of the card delimiter. */
export function isDelimiterLine(line: string): boolean {
  return DELIMITER_LINE_RE.test(line);
}

/** Whether an unfinished last line could still become a label or the delimiter, so it is not shown yet. */
export function mayBecomeMarker(line: string, names: readonly string[]): boolean {
  const body = line.replace(/^\s*(?:(?:[-*+>]|#{1,6})\s+)?(?:\*\*|__|\*|_)?/, "");
  if (body === "") return line.trim() !== "";
  if (/^=+\s*(?:E|EN|END)?\s*=*$/i.test(body)) return true;
  const upper = body.toUpperCase();
  return names.some((name) => name.startsWith(upper));
}

/** Replace drifted delimiter lines with the delimiter itself. */
export function normalizeDelimiters(text: string): string {
  return text
    .split("\n")
    .map((line) => (isDelimiterLine(line) ? CARD_DELIMITER : line))
    .join("\n");
}
