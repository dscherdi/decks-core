/**
 * Cloze deletions inside MathJax (`$ … ==answer== … $`) can't go through the
 * usual `==text==` → `<mark>` → blank-span path: MathJax owns the `$…$` span, so
 * `==` would be literal (invalid) LaTeX and never becomes a `<mark>`.
 *
 * This pure transform runs BEFORE markdown rendering. It rewrites only the
 * `==…==` that fall inside a math span into valid LaTeX (blank / reveal /
 * context) and leaves out-of-math clozes as `==…==` for the existing
 * `<mark>`-based post-processor — returning the active index adjusted to the
 * non-math clozes so the two index spaces stay aligned. A card with no math is
 * returned unchanged with `markActiveIndex === activeOrder`.
 */

import type { ClozeShowContext } from "../database/types";

// Mirrors the on-disk cloze marker the parser counts (single line, non-greedy).
const CLOZE_REGEX = /==((?:(?!==).)+)==/g;
// `$$…$$` (block) first, then inline `$…$` (no unescaped `$` inside).
const MATH_REGEX = /\$\$([\s\S]+?)\$\$|\$((?:\\\$|[^$])+?)\$/g;

const MATH_BLANK = "\\boxed{?}"; // the active cloze — answer this
const MATH_HIDDEN = "\\boxed{\\cdots}"; // other hidden clozes in the same span

export interface PreparedClozeMath {
  markdown: string;
  markActiveIndex: number;
}

function mathRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = new RegExp(MATH_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) ranges.push([m.index, re.lastIndex]);
  return ranges;
}

function mathClozeLatex(
  answer: string,
  isActive: boolean,
  mode: ClozeShowContext,
  revealed: boolean
): string {
  if (isActive) return revealed ? `\\underline{${answer}}` : MATH_BLANK;
  return mode === "hidden" ? MATH_HIDDEN : answer;
}

export function prepareClozeMath(
  content: string,
  activeOrder: number,
  mode: ClozeShowContext,
  revealed: boolean
): PreparedClozeMath {
  const ranges = mathRanges(content);
  const cloze = new RegExp(CLOZE_REGEX.source, "g");

  let out = "";
  let last = 0;
  let i = 0;
  let nonMath = 0;
  let markActiveIndex = -1;
  let m: RegExpExecArray | null;
  while ((m = cloze.exec(content)) !== null) {
    const start = m.index;
    const end = cloze.lastIndex;
    out += content.slice(last, start);
    // A cloze is "in math" only when it sits strictly inside a `$…$` span. A cloze
    // that wraps or merely contains math (`==$…$==`) is NOT contained by it, so it
    // stays `==…==` for the <mark> post-processor.
    const inMath = ranges.some(([s, e]) => start >= s && end <= e);
    if (inMath) {
      out += mathClozeLatex(m[1], i === activeOrder, mode, revealed);
    } else {
      if (i === activeOrder) markActiveIndex = nonMath;
      nonMath++;
      out += m[0];
    }
    last = end;
    i++;
  }
  out += content.slice(last);

  return { markdown: out, markActiveIndex };
}
