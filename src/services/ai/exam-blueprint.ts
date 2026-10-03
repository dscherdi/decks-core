/** Planning an exam before it is generated. */

import type { ExamQuestionType } from "../../database/types";

/** One outline section, with what it holds and what it owes the exam. */
export interface BlueprintSection {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  /** Pages of this section that were actually selected. */
  pages: number;
  /** Cards already citing those pages. */
  cards: number;
  questions: number;
  /** Read and found to hold nothing examinable — a solutions section. */
  excluded?: boolean;
  /** Outside the chapter selection: listed for the whole picture, never planned. */
  unselected?: boolean;
}

/** A section questions can be planned for. */
export function isPlannable(s: BlueprintSection): boolean {
  return !s.excluded && !s.unselected;
}

const MAX_PER_SECTION = 99;

export function clampSectionQuestions(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_PER_SECTION, Math.round(n)));
}

export function blueprintTotal(sections: readonly BlueprintSection[]): number {
  return sections.reduce((n, s) => n + (isPlannable(s) ? s.questions : 0), 0);
}

/**
 * Spread a total across sections in proportion to their pages. Largest
 * remainder, so the parts sum to exactly the total rather than to a rounded
 * approximation of it.
 */
export function autoWeightByPages(
  sections: readonly BlueprintSection[],
  total: number,
): BlueprintSection[] {
  const active = sections
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => isPlannable(s) && s.pages > 0);
  const totalPages = active.reduce((n, { s }) => n + s.pages, 0);
  const share = new Map<string, number>();
  if (totalPages > 0 && total > 0) {
    const exact = active.map(({ s, index }) => ({
      id: s.id,
      index,
      pages: s.pages,
      value: (total * s.pages) / totalPages,
    }));
    let assigned = 0;
    for (const e of exact) {
      const floor = Math.floor(e.value);
      share.set(e.id, floor);
      assigned += floor;
    }
    const byRemainder = [...exact].sort((a, b) => {
      const ra = a.value - Math.floor(a.value);
      const rb = b.value - Math.floor(b.value);
      if (rb !== ra) return rb - ra;
      if (b.pages !== a.pages) return b.pages - a.pages;
      return a.index - b.index;
    });
    for (let k = 0; k < total - assigned; k++) {
      const e = byRemainder[k % byRemainder.length];
      share.set(e.id, (share.get(e.id) ?? 0) + 1);
    }
  }
  return sections.map((s) => ({ ...s, questions: share.get(s.id) ?? 0 }));
}

/**
 * A section the ledger read and found nothing examinable in. Without the
 * ledger this is indistinguishable from a section nobody has read.
 */
export function sectionHasNothingToLearn(
  pages: readonly number[],
  extracted: ReadonlySet<number>,
  conceptsPerPage: Readonly<Record<number, number>>,
): boolean {
  if (pages.length === 0) return false;
  return pages.every((p) => extracted.has(p) && (conceptsPerPage[p] ?? 0) === 0);
}

/** What an attempt would draw from. Only `generated` is written by this run. */
export interface QuestionMix {
  generated: number;
  mcq: number;
  typeIn: number;
  cloze: number;
}

export function mixTotal(mix: QuestionMix): number {
  return mix.generated + mix.mcq + mix.typeIn + mix.cloze;
}

/** Split an eligible pool the way an attempt would present it. */
export function mixFromPool(
  questions: ReadonlyArray<{ kind: ExamQuestionType; isCloze: boolean }>,
): QuestionMix {
  const mix: QuestionMix = { generated: 0, mcq: 0, typeIn: 0, cloze: 0 };
  for (const q of questions) {
    if (q.kind === "multiple-choice") mix.mcq += 1;
    else if (q.isCloze) mix.cloze += 1;
    else mix.typeIn += 1;
  }
  return mix;
}
