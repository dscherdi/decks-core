/** Obsidian `%%comments%%`, found the way the parser reads a note: fenced code keeps its `%%`. */

const CODE_FENCE = /^(`{3,}|~{3,})/;

export interface CommentSpan {
  /** Offset of the opening `%%`. */
  start: number;
  /** Offset just past the closing `%%`. */
  end: number;
  /** The text between the markers, untrimmed. */
  inner: string;
}

/** Which lines belong to a fenced code block, fences included; a fence line opens or closes one. */
export function fencedLines(lines: readonly string[]): boolean[] {
  let open = false;
  return lines.map((line) => {
    if (!CODE_FENCE.test(line.trim())) return open;
    open = !open;
    return true;
  });
}

/** Every comment in `text`, in order. One opened inside fenced code is code, not a comment. */
export function findComments(text: string): CommentSpan[] {
  if (!text.includes("%%")) return [];
  const fenced = fencedLines(text.split("\n"));
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const spans: CommentSpan[] = [];
  const pattern = /%%([\s\S]*?)%%/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (fenced[lineOf(match.index)]) {
      pattern.lastIndex = match.index + 2;
      continue;
    }
    spans.push({ start: match.index, end: match.index + match[0].length, inner: match[1] });
  }
  return spans;
}

/** `text` with each comment replaced by what `replace` returns for it. */
export function replaceComments(text: string, replace: (span: CommentSpan) => string): string {
  let out = "";
  let last = 0;
  for (const span of findComments(text)) {
    out += text.slice(last, span.start) + replace(span);
    last = span.end;
  }
  return out + text.slice(last);
}
