import type { Flashcard } from "../database/types";
import type { IDatabaseService } from "../database/DatabaseService.interface";
import { cardIdForKey, reverseBindingKey } from "../utils/anchors";
import { generateFlashcardId } from "../utils/hash";

/** A reverse card: its note's card read backwards, front and back swapped. */
export function isReverseCardId(id: string): boolean {
  return id.startsWith("rcard_");
}

// Every sync writes both rows from one parsed card, so this match is exact.
function isNoteCardOf(row: Flashcard, reverse: Flashcard): boolean {
  return (
    !isReverseCardId(row.id) &&
    row.deckId === reverse.deckId &&
    row.front === reverse.back &&
    row.back === reverse.front
  );
}

/**
 * The note card a reverse card reads backwards, or any other card itself; null when the
 * note card is gone. A token or the content hash names it in most cases, the deck otherwise.
 */
export async function noteCardOf(
  db: Pick<IDatabaseService, "getFlashcardById" | "getFlashcardsByDeck">,
  card: Flashcard
): Promise<Flashcard | null> {
  if (!isReverseCardId(card.id)) return card;
  const suffix = reverseBindingKey("");
  const key = card.anchor?.endsWith(suffix) ? card.anchor.slice(0, -suffix.length) : null;
  for (const id of [key && cardIdForKey(key), generateFlashcardId(card.back)]) {
    if (!id) continue;
    const row = await db.getFlashcardById(id);
    if (row && isNoteCardOf(row, card)) return row;
  }
  return (await db.getFlashcardsByDeck(card.deckId)).find((row) => isNoteCardOf(row, card)) ?? null;
}

export interface NoteCardGroup {
  /** The note card, or a reverse card whose note card is not among the cards given. */
  card: Flashcard;
  /** The note card and every reverse card that reads it backwards. */
  rows: Flashcard[];
}

/**
 * Cards as their notes hold them: one group per note card, in the order either row first appears.
 * A reverse card joins the note card its token names, else one with no token, as the ledger does.
 */
export function noteCardGroups(cards: readonly Flashcard[]): NoteCardGroup[] {
  const key = (deckId: string, front: string, back: string): string => `${deckId}\u0000${front}\u0000${back}`;
  const suffix = reverseBindingKey("");
  const own = new Map<Flashcard, NoteCardGroup>();
  const byContent = new Map<string, NoteCardGroup[]>();
  for (const card of cards) {
    if (isReverseCardId(card.id)) continue;
    const group = { card, rows: [card] };
    own.set(card, group);
    const k = key(card.deckId, card.front, card.back);
    byContent.set(k, [...(byContent.get(k) ?? []), group]);
  }
  const groups: NoteCardGroup[] = [];
  const listed = new Set<NoteCardGroup>();
  for (const card of cards) {
    let group = own.get(card);
    if (!group) {
      const notes = byContent.get(key(card.deckId, card.back, card.front)) ?? [];
      const token = card.anchor?.endsWith(suffix) ? card.anchor.slice(0, -suffix.length) : null;
      group =
        notes.find((note) => token !== null && note.card.anchor === token) ??
        notes.find((note) => !note.card.anchor) ?? { card, rows: [] };
      group.rows.push(card);
    }
    if (!listed.has(group)) {
      listed.add(group);
      groups.push(group);
    }
  }
  return groups;
}
