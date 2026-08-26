import type { Deck, DeckProfile, IDatabaseService } from "../../index";

/**
 * Shared behavioural suites, run against every `IDatabaseService`.
 *
 * The Obsidian plugin and the mobile app each implement this interface over the
 * same core logic, so identical input must produce identical rows. Asserting
 * that in one place is the only way the two surfaces stay honest: a suite that
 * lives beside one implementation only ever proves that implementation
 * self-consistent, which is how an empty `syncWithDisk()` passed 1,200 tests.
 *
 * These files run under Jest in the plugin and Vitest in the app, so they use
 * `describe` / `it` / `expect` as globals rather than importing either.
 */
export interface ConformanceHost {
  /** A fresh, empty database. Called once per test. */
  open(): Promise<IDatabaseService>;
  /** Release it. */
  close(db: IDatabaseService): Promise<void>;
  /** Names the surface in test output. */
  label: string;
}

/** A deck row with the fields every implementation requires. */
export function testDeck(overrides: Partial<Deck> = {}): Omit<Deck, "created" | "modified" | "profileId"> {
  return {
    id: "deck_conformance",
    name: "Conformance",
    filepath: "Conformance.md",
    tag: "#decks",
    lastReviewed: null,
    ...overrides,
  } as Omit<Deck, "created" | "modified" | "profileId">;
}

/** Sync a note's content into a deck, resolving its profile the way callers do. */
export async function syncNote(
  db: IDatabaseService,
  deckId: string,
  fileContent: string
): Promise<void> {
  const deck = await db.getDeckWithProfile(deckId);
  if (!deck) throw new Error(`no deck ${deckId}`);
  await db.syncFlashcardsForDeck({
    deckId,
    deckName: deck.name,
    deckFilepath: deck.filepath,
    deckConfig: deck.profile as DeckProfile,
    fileContent,
  });
}

/** A markdown table of Front/Back rows. */
export function table(rows: Array<[string, string]>): string {
  return (
    "## T\n\n| Front | Back |\n| --- | --- |\n" +
    rows.map(([f, b]) => `| ${f} | ${b} |`).join("\n") +
    "\n"
  );
}
