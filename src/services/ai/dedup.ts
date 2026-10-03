import { generateFlashcardId } from "../../utils/hash";
import type { IDatabaseService } from "../../database/DatabaseService.interface";
import type { GeneratedCard } from "./generation-prompt";

/** Keeping a generated card from colliding with one the deck already has.
 *  Identity is the sync layer's own hash. */

/** The id a card would be saved under, hashed over the front as the composer
 *  collapses it into a heading. */
export function generatedCardId(card: GeneratedCard): string {
  return generateFlashcardId(card.front.trim().replace(/\n+/g, " "));
}

export interface DedupResult {
  /** Cards not already present in the destination. */
  fresh: GeneratedCard[];
  /** Cards the destination already holds, in the order they were proposed. */
  duplicates: GeneratedCard[];
}

/** Split proposals against the ids a destination holds. Also collapses cards
 *  that duplicate each other within the batch. */
export function partitionAgainstDeck(
  cards: readonly GeneratedCard[],
  existingIds: ReadonlySet<string>,
): DedupResult {
  const fresh: GeneratedCard[] = [];
  const duplicates: GeneratedCard[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const id = generatedCardId(card);
    if (existingIds.has(id) || seen.has(id)) {
      duplicates.push(card);
      continue;
    }
    seen.add(id);
    fresh.push(card);
  }
  return { fresh, duplicates };
}

/** Proposals whose front a deck other than the destination already holds. The
 *  id follows the front, so writing one here would not add a card here. */
export async function heldByOtherDecks(
  db: Pick<IDatabaseService, "getFlashcardById">,
  cards: readonly GeneratedCard[],
  destinationDeckId: string | null,
): Promise<Set<GeneratedCard>> {
  const held = new Set<GeneratedCard>();
  for (const card of cards) {
    const existing = await db.getFlashcardById(generatedCardId(card));
    if (existing && existing.deckId !== destinationDeckId) held.add(card);
  }
  return held;
}
