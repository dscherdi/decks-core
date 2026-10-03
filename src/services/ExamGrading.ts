/**
 * Objective grading for exam answers: typed-answer normalization and
 * comparison, multi-select index-set equality, and the string-mode
 * gradability check for type-in questions.
 */

import { levenshteinDistance, levenshteinSimilarityAbove } from "../utils/string";

const TOLERANT_MIN_LENGTH = 4;
const TOLERANT_SIMILARITY_PCT = 85;
const MAX_GRADABLE_ANSWER_LENGTH = 120;
/** Longest expected answer graded by meaning. */
export const MAX_MEANING_ANSWER_LENGTH = 600;

const EMBED_REGEX = /!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g;
const WIKILINK_REGEX = /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;
const MD_LINK_REGEX = /\[([^\]]*)\]\([^)]*\)/g;
const INLINE_MARKUP_REGEX = /(\*\*|__|==|~~|\*|_|`)/g;

/** Reduce a markdown answer line to comparable plain text. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(EMBED_REGEX, "")
    .replace(WIKILINK_REGEX, (_m, target: string, alias?: string) => alias ?? target)
    .replace(MD_LINK_REGEX, "$1")
    .replace(INLINE_MARKUP_REGEX, "");
}

/** Trim, collapse whitespace, casefold and strip diacritics. */
export function normalizeExamAnswer(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * The words of an answer, for tolerant grading: punctuation and a leading
 * "the" are not part of what was asked. Other articles can carry meaning ("A major").
 */
function tolerantForm(text: string): string {
  return normalizeExamAnswer(text)
    .replace(/\p{P}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/**
 * Grade a typed answer against the expected text. Tolerant mode floors the
 * ratio threshold: very short answers require an exact match, longer ones
 * accept one edit or >85% similarity.
 */
export function isTypedAnswerCorrect(
  given: string,
  expected: string,
  mode: "exact" | "tolerant"
): boolean {
  if (normalizeExamAnswer(given) === normalizeExamAnswer(expected)) return true;
  if (mode === "exact") return false;
  const a = tolerantForm(given);
  const b = tolerantForm(expected);
  if (a === b) return true;
  if (b.length < TOLERANT_MIN_LENGTH) return false;
  if (levenshteinDistance(a, b, 1) <= 1) return true;
  return levenshteinSimilarityAbove(a, b, TOLERANT_SIMILARITY_PCT);
}

/** Set equality over selected option indices (multi-select all-or-nothing). */
export function indexSetsEqual(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>
): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
}

/**
 * The graded answer text for a type-in question: the cloze target segment
 * when present, otherwise the first non-empty line of the back, reduced to
 * plain text.
 */
export function getTypeInAnswerLine(
  back: string,
  clozeText: string | null | undefined
): string {
  if (clozeText !== null && clozeText !== undefined && clozeText.trim() !== "") {
    return stripInlineMarkdown(clozeText).trim();
  }
  const firstLine = back
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return stripInlineMarkdown(firstLine ?? "").trim();
}

export type TypeInGradability =
  | { gradable: true; answer: string }
  | { gradable: false; reason: "answer-too-long" };

/**
 * String modes only (callers skip this under self-grading): an embed-only
 * or over-long answer cannot be honestly string-graded.
 */
export function checkTypeInGradability(
  answerLine: string,
  maxLength = MAX_GRADABLE_ANSWER_LENGTH
): TypeInGradability {
  const normalized = normalizeExamAnswer(answerLine);
  if (normalized === "" || normalized.length > maxLength) {
    return { gradable: false, reason: "answer-too-long" };
  }
  return { gradable: true, answer: answerLine };
}

const NUMBER_REGEX = /(?:(?<![\p{L}\p{N}])[-\u2212])?\d+(?:[ ,.\u00a0\u202f']\d{3})*(?:[.,]\d+)?/gu;

/** Numbers in a text; a decimal comma and group separators are read as one number. */
export function extractAnswerNumbers(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(NUMBER_REGEX)) {
    let raw = match[0].replace(/[\u00a0\u202f' ]/g, "").replace("\u2212", "-");
    const lastComma = raw.lastIndexOf(",");
    const lastDot = raw.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      raw = lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
    } else if (lastComma >= 0) {
      raw = /,\d{3}$/.test(raw) && !/^-?0,/.test(raw) ? raw.replace(/,/g, "") : raw.replace(",", ".");
    } else if ((raw.match(/\./g) ?? []).length > 1) {
      raw = raw.replace(/\./g, "");
    }
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** The unit or label left beside the numbers, compared loosely. */
function numericRemainder(text: string): string {
  return normalizeExamAnswer(text.replace(NUMBER_REGEX, " "))
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameNumbers(a: number[], b: number[]): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return a.length === b.length && a.every((x) => b.some((y) => near(x, y))) && b.every((y) => a.some((x) => near(x, y)));
}

/**
 * For an expected answer that is a value ("42", "3,5 m/s"): true when the typed
 * answer states the same numbers and unit, false when it states other numbers,
 * null when the numbers alone do not settle it.
 */
export function numericAnswerVerdict(given: string, expected: string): boolean | null {
  const want = extractAnswerNumbers(expected);
  const unit = numericRemainder(expected);
  if (want.length === 0 || unit.length > 8) return null;
  const got = extractAnswerNumbers(given);
  if (got.length === 0) return null;
  if (!sameNumbers(got, want)) return false;
  const givenUnit = numericRemainder(given);
  if (givenUnit === "" || givenUnit === unit) return true;
  return null;
}

/** Syntax where punctuation and digits carry meaning: calls, indexing, members, operators. */
export function looksLikeCodeAnswer(text: string): boolean {
  return /`|\w\(|\w\[|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]{2,}|=>|->|::|[=!<>]=|&&|\|\||;\s*$/.test(text);
}

/**
 * The words of an answer: case, punctuation, symbols, a leading "the" and
 * Latin accents do not count. Marks on other scripts do (が/か, й/и).
 */
function answerWords(text: string): string {
  return text
    .normalize("NFD")
    .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/**
 * What "By meaning" grading settles on the device: an empty answer, code typed
 * exactly, the same words, or the same value. No edit distance: one letter or
 * one "not" can change the meaning, so anything else goes to the backend (null).
 */
export function localMeaningVerdict(
  given: string,
  expected: string
): { correct: boolean; method: "meaning" | "exact" | "numeric" } | null {
  if (given.trim() === "") return { correct: false, method: "meaning" };
  if (looksLikeCodeAnswer(expected)) {
    return given.replace(/\s+/g, "") === expected.replace(/\s+/g, "") ? { correct: true, method: "exact" } : null;
  }
  if (answerWords(given) === answerWords(expected)) return { correct: true, method: "exact" };
  return numericAnswerVerdict(given, expected) === true ? { correct: true, method: "numeric" } : null;
}
