import type {
  RefactorCardType,
  RefactorFieldSet,
  RefactorProposal,
  RefactorResult,
} from "../services/ai/types";

export type BatchStatus =
  | "pending"
  | "running"
  | "ready"
  | "accepted"
  | "empty"
  | "error";

/**
 * Per-card state for the batch refactor flow. Generic over the card type so
 * core stays decoupled from any host's flashcard model — only `id` is read
 * here; the rest of the card is passed back to the host's apply callbacks.
 */
export interface BatchCardState<TCard extends { id: string }> {
  card: TCard;
  status: BatchStatus;
  mode: "refactor" | "split";
  proposed?: RefactorFieldSet;
  proposals: RefactorProposal[];
  splitCards?: RefactorFieldSet[];
  error?: string;
}

/** Card types whose source format can be split into multiple cards. */
export const SPLITTABLE: ReadonlySet<RefactorCardType> = new Set([
  "header-paragraph",
  "table",
  "cloze",
]);

export function isSplittable(type: RefactorCardType): boolean {
  return SPLITTABLE.has(type);
}

/** Whether a card should actually be split: only when split is on and its type supports it. */
export function effectiveSplit(splitOn: boolean, type: RefactorCardType): boolean {
  return splitOn && isSplittable(type);
}

/** Map a run result onto a card state (split → splitCards, else → proposed/proposals). */
export function cardResultPatch(
  res: RefactorResult,
  isSplit: boolean,
): Pick<
  BatchCardState<{ id: string }>,
  "status" | "mode" | "proposed" | "proposals" | "splitCards"
> {
  if (isSplit) {
    const splitCards = res.splitCards ?? [];
    return {
      mode: "split",
      splitCards,
      proposals: [],
      status: splitCards.length > 0 ? "ready" : "empty",
    };
  }
  return {
    mode: "refactor",
    proposed: res.proposed,
    proposals: res.proposals,
    status: res.proposals.length > 0 ? "ready" : "empty",
  };
}

/** Stage every Ready card (Accept all). */
export function acceptAllStates<TCard extends { id: string }>(
  states: BatchCardState<TCard>[],
): BatchCardState<TCard>[] {
  return states.map((s) =>
    s.status === "ready" ? { ...s, status: "accepted" } : s,
  );
}

/** Un-stage every Accepted card back to Ready (Discard all). */
export function discardAllStates<TCard extends { id: string }>(
  states: BatchCardState<TCard>[],
): BatchCardState<TCard>[] {
  return states.map((s) =>
    s.status === "accepted" ? { ...s, status: "ready" } : s,
  );
}

/** Move a single card from one status to another by id (accept / dismiss). */
export function setCardStatus<TCard extends { id: string }>(
  states: BatchCardState<TCard>[],
  id: string,
  from: BatchStatus,
  to: BatchStatus,
): BatchCardState<TCard>[] {
  return states.map((s) =>
    s.card.id === id && s.status === from ? { ...s, status: to } : s,
  );
}

export interface ApplyCallbacks<TCard extends { id: string }> {
  apply: (
    card: TCard,
    accepted: RefactorProposal[],
  ) => Promise<{ ok: boolean; error?: string }>;
  applySplit: (
    card: TCard,
    cards: RefactorFieldSet[],
  ) => Promise<{ ok: boolean; error?: string }>;
}

export interface ApplyResult<TCard extends { id: string }> {
  applied: number;
  skipped: number;
  failed: number;
  states: BatchCardState<TCard>[];
}

/**
 * Apply every Accepted card: split cards go through `applySplit`, the rest
 * through `apply`. Non-accepted cards are skipped; failures are tallied and the
 * card is marked `error`. Returns the tally and the updated states.
 */
export async function applyBatch<TCard extends { id: string }>(
  states: BatchCardState<TCard>[],
  { apply, applySplit }: ApplyCallbacks<TCard>,
): Promise<ApplyResult<TCard>> {
  const next = states.map((s) => ({ ...s }));
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const st of next) {
    if (st.status !== "accepted") {
      skipped++;
      continue;
    }
    const r =
      st.mode === "split"
        ? await applySplit(st.card, st.splitCards ?? [])
        : await apply(st.card, st.proposals);
    if (r.ok) {
      applied++;
    } else {
      failed++;
      st.status = "error";
      st.error = r.error;
    }
  }
  return { applied, skipped, failed, states: next };
}
