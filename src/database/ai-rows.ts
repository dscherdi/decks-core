import type { AiSession, AiStagedCard } from "./types";
import type { SqlJsValue } from "./sql-types";
import { generateFlashcardId } from "../utils/hash";

/** Values for INSERT_AI_SESSION, in column order. */
export function aiSessionValues(s: AiSession): SqlJsValue[] {
  return [
    s.id,
    s.sourceKind,
    s.sourceRef,
    s.sourceHash,
    JSON.stringify(s.selectedIds ?? []),
    s.deckId,
    s.profileId,
    s.model,
    s.spendCents ?? 0,
    JSON.stringify(s.turns ?? []),
    s.archived ? 1 : 0,
    s.touchedAt,
    s.created,
    s.modified,
  ];
}

/** Values for INSERT_AI_STAGED_CARD, in column order. */
export function aiStagedCardValues(c: AiStagedCard): SqlJsValue[] {
  return [
    c.id,
    c.sessionId,
    c.front,
    c.back,
    c.notes,
    c.cardType,
    c.options === null ? null : JSON.stringify(c.options),
    c.correct === null ? null : JSON.stringify(c.correct),
    c.explanation,
    c.valid === null ? null : c.valid ? 1 : 0,
    c.sourcePage,
    c.sectionIdx,
    c.conceptId,
    c.status,
    c.rubricVerdict,
    JSON.stringify(c.rubricCodes ?? []),
    c.fixProposal,
    c.parentId,
    c.origin,
    c.dedupHash,
    c.created,
    c.modified,
  ];
}

/** A concept's id: the same term on the same page of the same source is one concept everywhere. */
export function aiConceptId(sourceHash: string, page: number, term: string): string {
  return `${sourceHash}:${page}:${generateFlashcardId(term)}`;
}

/** `current` with the defined fields of `patch` applied, and whether any of them changed it. */
export function applyRowPatch<T extends object, P extends Partial<T>>(
  current: T,
  patch: P,
): { next: T; changed: boolean } {
  const next = { ...current };
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof T & keyof P>) {
    const value = patch[key];
    if (value === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(current[key])) changed = true;
    next[key] = value as T[keyof T & keyof P];
  }
  return { next, changed };
}
