import type { Deck } from "./types";

/** A note whose path hashes to the deck id another note's deck already holds. */
export class DeckIdCollisionError extends Error {
  constructor(readonly filepath: string, readonly heldBy: string) {
    super(`"${filepath}" gets the same deck id as "${heldBy}"`);
    this.name = "DeckIdCollisionError";
  }
}

/** Refuses a deck id that already belongs to another note's deck. */
export function assertDeckIdFree(existing: Pick<Deck, "filepath"> | null, filepath: string): void {
  if (existing && existing.filepath !== filepath) {
    throw new DeckIdCollisionError(filepath, existing.filepath);
  }
}
