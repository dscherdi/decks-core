import type { AnkiParsedCard } from "./AnkiTypes";

export interface AnkiRenderedDeck {
  deckName: string; // original Anki deck path ("Parent::Child")
  relativePath: string; // vault-relative path without extension, mirroring the hierarchy
  tag: string; // deck tag for the file's frontmatter (no leading #)
  content: string; // full markdown file content
  cards: AnkiParsedCard[]; // every card for this deck (each cloze ord kept, for history)
}

const ILLEGAL_PATH = /[\\/:*?"<>|#^[\]]/g;

/**
 * Turns parsed Anki cards into one Decks markdown file per Anki deck, in
 * header-paragraph format. Cloze notes collapse to a single entry (Decks expands
 * the `==highlights==` into per-cloze cards); every other card becomes its own
 * `## front` / paragraph-back entry, including reverse templates.
 */
export class AnkiDeckRenderer {
  /**
   * @param baseTag the migration subtag every deck tag nests under (no `#`,
   *   e.g. "decks/anki"). Profile mapping is applied to this subtag.
   */
  static render(cards: AnkiParsedCard[], baseTag: string, headerLevel: number): AnkiRenderedDeck[] {
    const byDeck = new Map<string, AnkiParsedCard[]>();
    for (const card of cards) {
      const group = byDeck.get(card.deckName);
      if (group) group.push(card);
      else byDeck.set(card.deckName, [card]);
    }

    const decks: AnkiRenderedDeck[] = [];
    for (const [deckName, deckCards] of byDeck) {
      decks.push({
        deckName,
        relativePath: AnkiDeckRenderer.deckPath(deckName),
        tag: AnkiDeckRenderer.deckTag(baseTag, deckName),
        content: AnkiDeckRenderer.renderFile(deckCards, baseTag, deckName, headerLevel),
        cards: deckCards,
      });
    }
    return decks.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private static renderFile(
    cards: AnkiParsedCard[],
    baseTag: string,
    deckName: string,
    headerLevel: number
  ): string {
    const level = Math.min(6, Math.max(1, headerLevel || 2));
    const hashes = "#".repeat(level);
    const tag = AnkiDeckRenderer.deckTag(baseTag, deckName);

    const frontmatter = ["---", "tags:", `  - ${tag}`, "---", ""].join("\n");

    const sections: string[] = [];
    const seenClozeNotes = new Set<number>();
    for (const card of cards) {
      if (card.isCloze) {
        if (seenClozeNotes.has(card.noteId)) continue;
        seenClozeNotes.add(card.noteId);
      }
      const front = card.front.trim() || `Card ${card.noteId}-${card.ord}`;
      sections.push(`${hashes} ${front}\n\n${card.back.trim()}`);
    }

    return frontmatter + sections.join("\n\n") + "\n";
  }

  // "Parent::Child" → "Parent/Child" with each segment cleaned for a vault path.
  private static deckPath(deckName: string): string {
    return deckName
      .split("::")
      .map((segment) => segment.replace(ILLEGAL_PATH, " ").replace(/\s+/g, " ").trim())
      .filter((segment) => segment.length > 0)
      .join("/");
  }

  // baseTag + a slugified hierarchy ("decks/anki/parent/child").
  private static deckTag(baseTag: string, deckName: string): string {
    const base = baseTag.replace(/^#/, "").replace(/\/+$/, "");
    const slug = deckName
      .split("::")
      .map((segment) => AnkiDeckRenderer.slugify(segment))
      .filter((segment) => segment.length > 0)
      .join("/");
    return slug ? `${base}/${slug}` : base;
  }

  private static slugify(segment: string): string {
    return segment
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
