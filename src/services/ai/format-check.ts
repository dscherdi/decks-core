import { CARD_DELIMITER, COVERED_MARKER } from "./prompts";

/** Display math: `$$…$$`, across lines. */
export const MATH_BLOCK_RE = /^\$\$([\s\S]+?)\$\$/;
/** Inline math: `$…$` on one line, `\$` allowed inside. */
export const MATH_INLINE_RE = /^\$((?:\\\$|[^$\n])+?)\$/;

/**
 * Keeps prices out of math: `$5 and $10` has a space against a delimiter, and a
 * closing `$` followed by a digit is a second amount rather than an expression.
 */
export function isInlineMathBody(body: string, rest: string): boolean {
  if (body.trim().length === 0) return false;
  if (/^\s|\s$/.test(body)) return false;
  return !/^\d/.test(rest);
}

export interface MathSpan {
  latex: string;
  display: boolean;
  start: number;
  end: number;
}

type Range = [start: number, end: number];

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const CODE_SPAN_RE = /(`+)(?!`)[^`\n]*?[^`]\1(?!`)/g;

function blank(text: string, ranges: readonly Range[]): string {
  let out = text;
  for (const [start, end] of ranges) {
    out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, " ") + out.slice(end);
  }
  return out;
}

/** Where code fences and inline code spans sit; nothing inside them is markup. */
function codeRanges(text: string): Range[] {
  const fences: Range[] = [...text.matchAll(FENCE_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const outside = blank(text, fences);
  const spans: Range[] = [...outside.matchAll(CODE_SPAN_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  return [...fences, ...spans].sort((a, b) => a[0] - b[0]);
}

/** Code fences and inline code spans blanked out, so nothing inside them is read as markup. */
export function maskCode(text: string): string {
  return blank(text, codeRanges(text));
}

/** The math a renderer would typeset, by the same rules, outside code. */
export function scanMath(text: string): MathSpan[] {
  const masked = maskCode(text);
  const spans: MathSpan[] = [];
  let i = 0;
  while (i < masked.length) {
    const at = masked.indexOf("$", i);
    if (at < 0) break;
    if (at > 0 && masked[at - 1] === "\\") {
      i = at + 1;
      continue;
    }
    const src = masked.slice(at);
    const block = MATH_BLOCK_RE.exec(src);
    if (block) {
      spans.push({ latex: text.slice(at + 2, at + block[0].length - 2), display: true, start: at, end: at + block[0].length });
      i = at + block[0].length;
      continue;
    }
    const inline = MATH_INLINE_RE.exec(src);
    if (inline && isInlineMathBody(inline[1], src.slice(inline[0].length))) {
      spans.push({ latex: text.slice(at + 1, at + inline[0].length - 1), display: false, start: at, end: at + inline[0].length });
      i = at + inline[0].length;
      continue;
    }
    i = at + (src.startsWith("$$") ? 2 : 1);
  }
  return spans;
}

export type FormatIssueKind =
  | "paren_math"
  | "math_spacing"
  | "unclosed_math"
  | "invalid_math"
  | "unbalanced_bold"
  | "unbalanced_code"
  | "unbalanced_highlight"
  | "stray_label"
  | "stray_delimiter"
  | "fenced_field"
  | "table_display_math";

export type FormatField = "front" | "back" | "notes";

export interface FormatIssue {
  kind: FormatIssueKind;
  field: FormatField;
  /** The math the validator rejected, or its message. */
  detail?: string;
}

/** Rejects math the renderer cannot typeset: returns the reason, or null when it renders. */
export type MathValidator = (latex: string, display: boolean) => string | null;

export interface FormatCard {
  front: string;
  back: string;
  notes?: string;
}

const PAREN_MATH_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/;
const STRAY_LABEL_RE = /^\s*(?:\*\*)?(FRONT|BACK|NOTES|SECTION|PAGE)(?:\*\*)?\s*:/m;
const FENCED_FIELD_RE = /^(`{3,}|~{3,})[ \t]*(markdown|md|text|plain|plaintext)?[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i;
// Formula-like content: a command, a script, a brace or an equals sign.
const MATHY_RE = /[\\^_{}=]/;

/** Braces that do not pair up, ignoring escaped ones. */
function bracesBalanced(latex: string): boolean {
  let depth = 0;
  const bare = latex.replace(/\\[{}]/g, "");
  for (const ch of bare) {
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Code and typeset math, in order: what a repair must not touch. */
function protectedRanges(text: string): Range[] {
  const math: Range[] = scanMath(text).map((s) => [s.start, s.end]);
  return [...codeRanges(text), ...math].sort((a, b) => a[0] - b[0]);
}

/** Text with code and math blanked, for counting markup that must pair up. */
function prose(text: string): string {
  return blank(text, protectedRanges(text));
}

/** Apply `fix` to the stretches between code and math, leaving those untouched. */
function betweenProtected(text: string, fix: (part: string) => string): string {
  let out = "";
  let at = 0;
  for (const [start, end] of protectedRanges(text)) {
    if (start < at) continue;
    out += fix(text.slice(at, start)) + text.slice(start, end);
    at = end;
  }
  return out + fix(text.slice(at));
}

/** Math written with stray spaces inside its dollars, which then renders as text. */
const SPACED_MATH_RE = /(?<![\\$])\$([ \t]+[^$\n]*?|[^$\n]*?[ \t]+)\$(?!\d)/g;
const spacedIsMath = (body: string): boolean => MATHY_RE.test(body) || /^\s*[A-Za-z]\s*$/.test(body);

function fieldIssues(text: string, field: FormatField, validateMath?: MathValidator): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const add = (kind: FormatIssueKind, detail?: string): void => {
    if (!issues.some((i) => i.kind === kind)) issues.push({ kind, field, detail });
  };
  const code = maskCode(text);
  const plain = prose(text);

  if (PAREN_MATH_RE.test(code)) add("paren_math");
  for (const m of plain.matchAll(SPACED_MATH_RE)) if (spacedIsMath(m[1])) add("math_spacing");
  if ((plain.match(/\$\$/g) ?? []).length % 2 === 1) add("unclosed_math");
  // A lone dollar sign before a command or letter opens math that never closes; a price does not.
  for (const m of plain.matchAll(/(?<![\\$])\$(?!\$)(?=[\\A-Za-z])/g)) {
    if (!plain.slice((m.index ?? 0) + 1).split("\n")[0].includes("$")) add("unclosed_math");
  }
  for (const span of scanMath(text)) {
    const reason = !bracesBalanced(span.latex) ? "unbalanced braces" : (validateMath?.(span.latex, span.display) ?? null);
    if (reason !== null) add("invalid_math", reason);
    if (span.display && text.slice(text.lastIndexOf("\n", span.start) + 1).trimStart().startsWith("|")) {
      add("table_display_math");
    }
  }
  if ((plain.match(/\*\*/g) ?? []).length % 2 === 1) add("unbalanced_bold");
  if ((text.match(/^[ \t]*(`{3,}|~{3,})/gm) ?? []).length % 2 === 1) add("unbalanced_code");
  else if (code.split("\n").some((line) => (line.match(/`/g) ?? []).length % 2 === 1)) add("unbalanced_code");
  // Highlight marks hug their text; `a == b` in prose is left alone.
  if ((plain.match(/==(?=\S)(?!=)|(?<=\S)(?<!=)==/g) ?? []).length % 2 === 1) add("unbalanced_highlight");
  if (STRAY_LABEL_RE.test(code)) add("stray_label");
  if (text.includes(CARD_DELIMITER) || text.includes(COVERED_MARKER) || /^\s*={2,}\s*END\s*={2,}\s*$/im.test(code)) {
    add("stray_delimiter");
  }
  if (FENCED_FIELD_RE.test(text.trim())) add("fenced_field");
  return issues;
}

/** Formatting faults that would render wrongly, per field. */
export function checkCardFormat(card: FormatCard, validateMath?: MathValidator): FormatIssue[] {
  return [
    ...fieldIssues(card.front, "front", validateMath),
    ...fieldIssues(card.back, "back", validateMath),
    ...(card.notes ? fieldIssues(card.notes, "notes", validateMath) : []),
  ];
}

/** Only fixes that cannot change meaning: a lone `$` is never closed, since it may be a price. */
function repairField(text: string, label: FormatField): string {
  let out = text.trim();
  const fenced = FENCED_FIELD_RE.exec(out);
  if (fenced) out = fenced[3].trim();
  out = betweenProtected(out, (part) =>
    part
      .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `$$${body.trim()}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`),
  );
  out = betweenProtected(out, (part) =>
    part.replace(SPACED_MATH_RE, (m, body: string) => (spacedIsMath(body) ? `$${body.trim()}$` : m)),
  );
  // The model's own markers, left in a field.
  out = out
    .split("\n")
    .filter((line) => !/^\s*(?:\*\*)?\s*={2,}\s*(?:END|COVERED)\s*={2,}\s*(?:\*\*)?\s*$/i.test(line))
    .join("\n")
    .split(CARD_DELIMITER)
    .join("")
    .split(COVERED_MARKER)
    .join("");
  // A repeated label for this field, as in "BACK: BACK: answer".
  out = out.replace(new RegExp(`^\\s*(?:\\*\\*)?${label.toUpperCase()}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*`), "");
  // A bold mark left hanging at either end when a label's bold was split from it.
  if ((prose(out).match(/\*\*/g) ?? []).length % 2 === 1) {
    out = out.replace(/^\*\*\s*(?=\S)/, "");
    if ((prose(out).match(/\*\*/g) ?? []).length % 2 === 1) out = out.replace(/\s*\*\*$/, "");
  }
  return out.trim();
}

/** The card with every safe fix applied; the same card back when nothing needed fixing. */
export function repairCardFormat<T extends FormatCard>(card: T): T {
  const front = repairField(card.front, "front");
  const back = repairField(card.back, "back");
  const notes = card.notes ? repairField(card.notes, "notes") : card.notes;
  if (front === card.front && back === card.back && notes === card.notes) return card;
  return { ...card, front, back, notes };
}
