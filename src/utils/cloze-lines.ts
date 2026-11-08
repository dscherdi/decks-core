import type { Flashcard } from "../database/types";
import { scanClozeDeletions } from "./cloze-scanner";

type ClozeFields = Pick<Flashcard, "type" | "front" | "back" | "clozeOrder">;

/** The side of a cloze card that holds its `==markers==`: the back, or the front for a front-only cloze. */
export function clozeSource(card: Pick<Flashcard, "front" | "back">): string {
  return card.back.trim().length > 0 ? card.back : card.front;
}

/** The orders of the deletions on the same line as deletion `order`; just `order` when the source lacks it. */
export function clozeLineOrders(source: string, order: number): number[] {
  const deletions = scanClozeDeletions(source);
  const own = deletions.find((deletion) => deletion.order === order);
  if (!own) return [order];
  return deletions.filter((deletion) => deletion.lineIndex === own.lineIndex).map((deletion) => deletion.order);
}

/** The deletions a card blanks and reveals together: its whole line when clozes group by line, else its own. */
export function clozeActiveOrders(card: ClozeFields, groupByLine: boolean): number[] {
  const order = card.clozeOrder ?? 0;
  if (!groupByLine || card.type !== "cloze") return [order];
  return clozeLineOrders(clozeSource(card), order);
}

function lineKey(card: ClozeFields): string | null {
  if (card.type !== "cloze" || card.clozeOrder === null) return null;
  const own = scanClozeDeletions(clozeSource(card)).find((deletion) => deletion.order === card.clozeOrder);
  return own ? `${card.front}\u0000${card.back}\u0000${own.lineIndex}` : null;
}

/** A note's run of clozes as review steps: cards on one line share a step when grouped; first appearance sets the order. */
export function groupClozeRunByLine<T extends ClozeFields>(run: readonly T[], groupByLine: boolean): T[][] {
  if (!groupByLine) return run.map((card) => [card]);
  const steps: T[][] = [];
  const byLine = new Map<string, T[]>();
  for (const card of run) {
    const key = lineKey(card);
    const step = key === null ? undefined : byLine.get(key);
    if (step) {
      step.push(card);
      continue;
    }
    const created = [card];
    if (key !== null) byLine.set(key, created);
    steps.push(created);
  }
  return steps;
}

/** One-based position label for the clozes a step shows: "2", or "1–3" for a line of them. */
export function clozeOrderRange(orders: readonly number[]): string {
  if (orders.length === 0) return "";
  const first = Math.min(...orders) + 1;
  const last = Math.max(...orders) + 1;
  return first === last ? String(first) : `${first}–${last}`;
}
