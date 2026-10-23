import { parseHeaderLevels, type DeckProfile, type DeckWithProfile } from "./types";
import { isDirectoryDeckPath } from "../services/directory/ids";

/** The profile settings that decide which cards a note parses into. */
export function profileParsingKey(profile: DeckProfile): string {
  const levels = [...parseHeaderLevels(profile)].sort((a, b) => a - b);
  return JSON.stringify({ levels, cloze: profile.clozeEnabled, exam: profile.examEnabled ?? false });
}

/**
 * Note decks whose parsing settings differ between two snapshots, after a profile was
 * edited, assigned or deleted. Their notes are unchanged, so only a forced parse picks it up.
 */
export function decksWithChangedParsing(
  before: readonly DeckWithProfile[],
  after: readonly DeckWithProfile[]
): DeckWithProfile[] {
  const previous = new Map(before.map((deck) => [deck.id, profileParsingKey(deck.profile)]));
  return after.filter((deck) => {
    const key = previous.get(deck.id);
    return key !== undefined && key !== profileParsingKey(deck.profile) && !isDirectoryDeckPath(deck.filepath);
  });
}
