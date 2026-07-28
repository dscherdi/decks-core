/**
 * Objective grading for exam answers: typed-answer normalization and
 * comparison, multi-select index-set equality, and the string-mode
 * gradability check for type-in questions.
 */

import { levenshteinDistance, levenshteinSimilarityAbove } from "../utils/string";

const TOLERANT_MIN_LENGTH = 4;
const TOLERANT_SIMILARITY_PCT = 85;
const MAX_GRADABLE_ANSWER_LENGTH = 120;

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
 * Grade a typed answer against the expected text. Tolerant mode floors the
 * ratio threshold: very short answers require an exact match, longer ones
 * accept one edit or >85% similarity.
 */
export function isTypedAnswerCorrect(
  given: string,
  expected: string,
  mode: "exact" | "tolerant"
): boolean {
  const a = normalizeExamAnswer(given);
  const b = normalizeExamAnswer(expected);
  if (a === b) return true;
  if (mode === "exact") return false;
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
export function checkTypeInGradability(answerLine: string): TypeInGradability {
  const normalized = normalizeExamAnswer(answerLine);
  if (normalized === "" || normalized.length > MAX_GRADABLE_ANSWER_LENGTH) {
    return { gradable: false, reason: "answer-too-long" };
  }
  return { gradable: true, answer: answerLine };
}
