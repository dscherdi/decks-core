/** The session thread's shape rules, testable without rendering anything. */

import type { AiSessionTurn, AiTurnRound } from "../../database/types";
import type { GeneratedCard } from "./generation-prompt";
import { checkCardFormat, type FormatIssue } from "./format-check";

export type ThreadBlock =
  | { kind: "prompt"; id: string; text: string }
  | { kind: "result"; id: string; rowIds: string[]; replacesId?: string }
  | {
      kind: "answer";
      id: string;
      text: string;
      pages: number[];
      gaps: Array<{ term: string; page: number | null }>;
      /** The row this answer was turned into, once it has been. */
      cardRowId?: string;
    };

/** The most recent round with cards, which a refinement would supersede. With
 *  `refinable`, only a round holding at least one row it accepts qualifies. */
export function lastResultBlock(
  blocks: readonly ThreadBlock[],
  refinable?: (rowId: string) => boolean,
): Extract<ThreadBlock, { kind: "result" }> | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "result" || b.rowIds.length === 0) continue;
    if (!refinable || b.rowIds.some(refinable)) return b;
  }
  return undefined;
}

/** Blocks a later refinement replaced. Derived, never stored; a replacement that
 *  produced no cards (failed, stopped, empty) replaces nothing. */
export function supersededIds(blocks: readonly ThreadBlock[]): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) {
    if (b.kind === "result" && b.replacesId && b.rowIds.length > 0) out.add(b.replacesId);
  }
  return out;
}

/** An instruction over an existing pile refines; an empty prompt continues. */
export function isRefinement(hasRows: boolean, prompt: string): boolean {
  return hasRows && prompt.trim().length > 0;
}

/** Insert a fix's children directly after the row they replaced. */
export function insertAfter(
  rowIds: readonly string[],
  parentId: string,
  childIds: readonly string[],
): string[] {
  const at = rowIds.indexOf(parentId);
  if (at === -1) return [...rowIds];
  return [...rowIds.slice(0, at + 1), ...childIds, ...rowIds.slice(at + 1)];
}

/** Drop gone rows from their rounds, and rounds left empty, keeping the prompts
 *  and answers that framed them — those are the conversation, not a view of the pile. */
export function pruneBlocks(
  blocks: readonly ThreadBlock[],
  liveRowIds: ReadonlySet<string>,
): ThreadBlock[] {
  const out: ThreadBlock[] = [];
  for (const b of blocks) {
    if (b.kind !== "result") {
      out.push(b);
      continue;
    }
    const rowIds = b.rowIds.filter((id) => liveRowIds.has(id));
    if (rowIds.length > 0) out.push(rowIds.length === b.rowIds.length ? b : { ...b, rowIds });
  }
  return out;
}

/** A stored staged card's id without its session prefix. Restored rows keep it,
 *  so writing the pile again replaces those rows instead of copying them. */
export function localRowId(sessionId: string, storedId: string): string {
  const prefix = `${sessionId}:`;
  return storedId.startsWith(prefix) ? storedId.slice(prefix.length) : storedId;
}

/** The first `gen-N` number no restored row already holds. */
export function nextRowCounter(ids: readonly string[]): number {
  let next = 0;
  for (const id of ids) {
    const m = /^gen-(\d+)$/.exec(id);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  return next;
}

/** For each prompt or answer in the thread, the rounds that followed it. */
export function roundsByTurn(blocks: readonly ThreadBlock[]): AiTurnRound[][] {
  const order = new Map<string, number>();
  for (const b of blocks) if (b.kind === "result") order.set(b.id, order.size);
  const out: AiTurnRound[][] = [];
  for (const b of blocks) {
    if (b.kind !== "result") {
      out.push([]);
      continue;
    }
    const replaces = b.replacesId === undefined ? undefined : order.get(b.replacesId);
    const round: AiTurnRound = { rows: [...b.rowIds] };
    if (replaces !== undefined) round.replaces = replaces;
    // A round before any turn has nowhere to live; the restore puts it back as the last one.
    out[out.length - 1]?.push(round);
  }
  return out;
}

/**
 * Rebuild the thread from the turn log and the stored rows. Rounds keep their
 * cards and what they replaced. A row no round mentions comes back in a trailing
 * round when it is in `loose` (staged from elsewhere, e.g. the reader) and stays
 * out otherwise (cleared). A log from before rounds were recorded brings every
 * row back as one round.
 */
export function threadFromTurns(
  turns: readonly AiSessionTurn[],
  rowIds: readonly string[],
  newId: () => string,
  loose: ReadonlySet<string> = new Set(),
): ThreadBlock[] {
  const live = new Set(rowIds);
  const blocks: ThreadBlock[] = [];
  const roundIds: string[] = [];
  const recorded = turns.some((t) => t.rounds !== undefined);
  for (const turn of turns) {
    blocks.push(
      turn.role === "user"
        ? { kind: "prompt", id: newId(), text: turn.text }
        : {
            kind: "answer",
            id: newId(),
            text: turn.text,
            pages: turn.pages ?? [],
            gaps: turn.gaps ?? [],
          },
    );
    for (const round of turn.rounds ?? []) {
      const id = newId();
      const replacesId = round.replaces === undefined ? undefined : roundIds[round.replaces];
      roundIds.push(id);
      blocks.push({
        kind: "result",
        id,
        rowIds: round.rows.filter((row) => live.has(row)),
        ...(replacesId ? { replacesId } : {}),
      });
    }
  }
  if (!recorded && rowIds.length > 0) {
    blocks.push({ kind: "result", id: newId(), rowIds: [...rowIds] });
  } else if (recorded) {
    const placed = new Set(blocks.flatMap((b) => (b.kind === "result" ? b.rowIds : [])));
    const unplaced = rowIds.filter((row) => !placed.has(row) && loose.has(row));
    if (unplaced.length > 0) blocks.push({ kind: "result", id: newId(), rowIds: unplaced });
  }
  return pruneBlocks(blocks, live);
}

/** The cards a round is shown so it continues rather than repeats; a refinement is shown its own round instead. */
export function continuationCards<T extends { card: GeneratedCard }>(
  rows: readonly T[],
  refining: boolean,
): GeneratedCard[] | undefined {
  if (refining || rows.length === 0) return undefined;
  return rows.map((r) => r.card);
}

/** Whether a finished round leaves more to ask for: it added cards or was cut off, and the source is not spent. */
export function offersContinue(result: {
  cards?: readonly unknown[];
  truncated?: boolean;
  covered?: boolean;
}): boolean {
  return !result.covered && ((result.cards?.length ?? 0) > 0 || Boolean(result.truncated));
}

/** A staged card as a round summary counts it. */
export interface SummaryRow {
  card: GeneratedCard;
  keep: boolean;
  saved: boolean;
  verdict?: { verdict: string } | null;
  /** Set when a question does not parse. */
  invalid?: unknown;
}

export interface RoundSummary {
  count: number;
  /** Pages the cards cite, sorted, each once. */
  pages: number[];
  /** No rubric flag, no parse fault and no formatting fault. */
  clean: number;
  flagged: number;
  misformatted: number;
  kept: number;
  discarded: number;
  saved: number;
}

/** What a round holds, counted the same way on every surface. */
export function roundSummary(
  rows: readonly SummaryRow[],
  formatOf: (card: GeneratedCard) => readonly FormatIssue[] = (card) => checkCardFormat(card),
): RoundSummary {
  const out: RoundSummary = { count: rows.length, pages: [], clean: 0, flagged: 0, misformatted: 0, kept: 0, discarded: 0, saved: 0 };
  const pages = new Set<number>();
  for (const row of rows) {
    if (typeof row.card.page === "number") pages.add(row.card.page);
    const flagged = row.verdict?.verdict === "flagged" || Boolean(row.invalid);
    const misformatted = formatOf(row.card).length > 0;
    if (flagged) out.flagged += 1;
    if (misformatted) out.misformatted += 1;
    if (!flagged && !misformatted) out.clean += 1;
    if (row.saved) out.saved += 1;
    else if (row.keep) out.kept += 1;
    else out.discarded += 1;
  }
  out.pages = [...pages].sort((a, b) => a - b);
  return out;
}
