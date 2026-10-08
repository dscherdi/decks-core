// Which `==x==` runs are cloze deletions, and in what order. Parser, stamper and
// writers all count through here, so a deletion's index means the same to each.

const CLOZE_SOURCE = "==((?:(?!==).)+)==";
/** Inline code runs, matched by their own backtick fence so `` ` `` nests. */
const INLINE_CODE_SOURCE = "(`+)(?:(?!\\1)[\\s\\S])*?\\1";

export interface ClozeDeletion {
  /** The deleted text, without its `==` markers. */
  text: string;
  /** Position among all deletions in the scanned source. */
  order: number;
  /** Line of the source the deletion sits on. */
  lineIndex: number;
  /** Position among the deletions on its own line. */
  indexInLine: number;
  /** Offset of the opening `==` within its line. */
  start: number;
  /** Offset just past the closing `==` within its line. */
  end: number;
}

/** Half-open [from, to) ranges of the inline code spans on one line. */
export function inlineCodeSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  const regex = new RegExp(INLINE_CODE_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/** Deletions on one line, skipping any inside a code span (the renderer leaves code alone). */
export function scanLineDeletions(line: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const spans = inlineCodeSpans(line);
  const regex = new RegExp(CLOZE_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const start = match.index;
    if (spans.some(([from, to]) => start >= from && start < to)) continue;
    out.push({ text: match[1], start, end: start + match[0].length });
  }
  return out;
}

/** Deletions in a multi-line source, in document order. Deletions never span lines. */
export function scanClozeDeletions(source: string): ClozeDeletion[] {
  const out: ClozeDeletion[] = [];
  const lines = source.split("\n");
  let order = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const onLine = scanLineDeletions(lines[lineIndex]);
    onLine.forEach((d, indexInLine) => {
      out.push({ ...d, order: order++, lineIndex, indexInLine });
    });
  }
  return out;
}

/** True when the source holds at least one deletion. */
export function hasClozeDeletion(source: string): boolean {
  return source.split("\n").some((line) => scanLineDeletions(line).length > 0);
}

/** The source with every deletion swapped for `blank`, as a question shows it. */
export function blankClozeDeletions(source: string, blank: string): string {
  return source
    .split("\n")
    .map((line) => {
      let out = "";
      let at = 0;
      for (const deletion of scanLineDeletions(line)) {
        out += line.slice(at, deletion.start) + blank;
        at = deletion.end;
      }
      return out + line.slice(at);
    })
    .join("\n");
}
