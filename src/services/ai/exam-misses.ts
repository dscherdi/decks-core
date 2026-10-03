/** Turning a finished attempt into work. */

import { I18n } from "../../i18n/I18n";
import { formatPageList } from "./coverage";

export interface AttemptMiss {
  /** 1-based position in the attempt, as the results list numbers it. */
  index: number;
  cardId: string;
  /** The source page the card cites, when it carries one. */
  page: number | null;
  unanswered: boolean;
}

/** Pages the misses cluster into, and what that cluster wants doing. */
export interface WeakSection {
  startPage: number;
  endPage: number;
  pages: number[];
  misses: number;
  cards: number;
  /** No cards means write some; cards that keep failing want repair instead. */
  action: "generate" | "repair";
}

/** Every page a miss points at, ascending and deduplicated. */
export function missedPages(misses: readonly AttemptMiss[]): number[] {
  const pages = new Set<number>();
  for (const m of misses) if (m.page) pages.add(m.page);
  return [...pages].sort((a, b) => a - b);
}

/** Split pages into runs, tolerating a gap so two near misses stay together. */
export function clusterPages(
  pages: readonly number[],
  maxGap = 2,
): number[][] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: number[][] = [];
  let current: number[] = [];
  for (const page of sorted) {
    if (current.length === 0 || page - current[current.length - 1] <= maxGap) {
      current.push(page);
    } else {
      runs.push(current);
      current = [page];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Where an attempt went wrong, worst first, with the call the ledger's states
 * imply: a cluster with no cards wants cards; one with cards that keep being
 * got wrong wants those repaired.
 */
export function weakSections(
  misses: readonly AttemptMiss[],
  cardsByPage: Readonly<Record<number, number>>,
  maxGap = 2,
): WeakSection[] {
  const missesByPage: Record<number, number> = {};
  for (const m of misses) {
    if (m.page) missesByPage[m.page] = (missesByPage[m.page] ?? 0) + 1;
  }
  return clusterPages(missedPages(misses), maxGap)
    .map((pages) => {
      const cards = pages.reduce((n, p) => n + (cardsByPage[p] ?? 0), 0);
      return {
        startPage: pages[0],
        endPage: pages[pages.length - 1],
        pages,
        misses: pages.reduce((n, p) => n + (missesByPage[p] ?? 0), 0),
        cards,
        action: cards === 0 ? ("generate" as const) : ("repair" as const),
      };
    })
    .sort((a, b) => b.misses - a.misses || a.startPage - b.startPage);
}

/** The line over the weakest sections, singular where a count is one. */
export function missesSummary(misses: number, sections: number): string {
  const t = I18n.t.exam.aiMisses;
  const template =
    misses === 1 ? t.summaryOne : sections === 1 ? t.summaryOneSection : t.summary;
  return I18n.format(template, { count: misses, sections });
}

/** How many study cards a section has. */
export function missesSectionCards(cards: number): string {
  const t = I18n.t.exam.aiMisses;
  return I18n.format(cards === 1 ? t.sectionCardsOne : t.sectionCards, { count: cards });
}

/** The prompt a session from the misses opens with: the concepts missed when the
 *  ledger knows them, otherwise the pages. */
export function missesSessionPrompt(
  pages: readonly number[],
  concepts: ReadonlyArray<{ term: string; page: number }> = [],
): string {
  const t = I18n.t.exam.aiMisses;
  if (concepts.length > 0) {
    const terms = concepts.map((c) => `${c.term} (p. ${c.page})`).join(", ");
    return I18n.format(t.sessionPromptConcepts, { terms });
  }
  const template = new Set(pages).size === 1 ? t.sessionPromptOne : t.sessionPrompt;
  return I18n.format(template, { range: formatPageList(pages) });
}
