/** Page coverage counted over the pages cards cite. */

/** One page of a range, with the number of staged cards citing it. */
export interface PageHeatCell {
  page: number;
  count: number;
}

export interface PageHeatSummary {
  /** Pages with at least one card. */
  covered: number;
  /** Pages in the range that were sent to the model at all. */
  total: number;
  /** Pages carrying only one or two cards. */
  thin: number;
  /** Pages sent but never cited. */
  untouched: number;
}

/** How densely a page is covered. Three bands, matching the three strip tones. */
export type PageHeatTone = "strong" | "thin" | "none";

export function heatTone(count: number): PageHeatTone {
  if (count >= 3) return "strong";
  if (count > 0) return "thin";
  return "none";
}

/** One cell per sent page. Pages outside `sourced` were never offered, so they
 *  are omitted rather than drawn as gaps. */
export function pageHeat(
  startPage: number,
  endPage: number,
  sourced: ReadonlySet<number>,
  counts: Readonly<Record<number, number>>,
): PageHeatCell[] {
  const cells: PageHeatCell[] = [];
  for (let page = startPage; page <= endPage; page++) {
    if (!sourced.has(page)) continue;
    cells.push({ page, count: counts[page] ?? 0 });
  }
  return cells;
}

/** Takes the cells the strip drew, so the caption cannot drift from it. */
export function summarizeHeat(
  cells: readonly PageHeatCell[],
): PageHeatSummary {
  const total = cells.length;
  let thin = 0;
  let untouched = 0;
  for (const c of cells) {
    if (c.count === 0) untouched++;
    else if (c.count < 3) thin++;
  }
  return { covered: total - untouched, total, thin, untouched };
}

/** Every sent page that nothing cites, ascending. */
export function gapPages(
  sourced: ReadonlySet<number>,
  counts: Readonly<Record<number, number>>,
): number[] {
  return [...sourced].filter((p) => !counts[p]).sort((a, b) => a - b);
}

/** Condense a page list into ranges: `76–78, 91, 104–106`. */
export function formatPageList(pages: readonly number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  const flush = (): void => {
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  };
  for (const p of sorted.slice(1)) {
    if (p === prev || p === prev + 1) {
      prev = p;
      continue;
    }
    flush();
    start = p;
    prev = p;
  }
  flush();
  return parts.join(", ");
}
