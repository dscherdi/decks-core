/**
 * Structural types for the slice of an Anki collection the importer reads, plus
 * the normalized output the renderer/history-importer consume.
 */

export interface AnkiModelField {
  name: string;
  ord?: number;
}

export interface AnkiTemplate {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
}

/** A model (note type) from the `col.models` JSON. `type` 0 = standard, 1 = cloze. */
export interface AnkiModel {
  id: string;
  name: string;
  type: number;
  flds: AnkiModelField[];
  tmpls: AnkiTemplate[];
}

/** A deck from the `col.decks` JSON. `name` uses `::` for hierarchy. */
export interface AnkiDeckMeta {
  id: string;
  name: string;
}

/** Native scheduling columns from the `cards` table. */
export interface AnkiScheduling {
  type: number; // 0 new, 1 learning, 2 review, 3 relearning
  queue: number; // -1 suspended, 0 new, …
  due: number;
  ivl: number; // interval in days (negative = seconds, for learning)
  factor: number; // SM-2 ease, per-mille (2500 = 250%)
  reps: number;
  lapses: number;
  data: string; // JSON blob; may hold FSRS {"s":…,"d":…}
}

/**
 * One normalized card ready for rendering + history import. For basic models
 * this is a single template instance (note × ord). For cloze models each ord is
 * kept as its own card carrying the cloze it schedules, while the renderer
 * collapses a cloze note's cards into one markdown entry.
 */
export interface AnkiParsedCard {
  noteId: number;
  cardId: number;
  ord: number;
  isCloze: boolean;
  deckName: string; // full "Parent::Child" path
  front: string; // sanitized; used as the markdown header AND for id generation
  back: string; // sanitized primary answer (or the cloze sentence)
  notes: string; // secondary answer fields + relocated front-side media
  clozeBody?: string; // cloze only: full sentence with every {{cN::…}} → ==…==
  clozeText?: string; // cloze only: this ord's answer (the ==highlight== text)
  clozeOrder?: number; // cloze only: 0-based document order of this ord's highlight
  media: string[]; // referenced media filenames
  scheduling: AnkiScheduling;
}

export interface AnkiParseResult {
  cards: AnkiParsedCard[];
  deckNames: string[]; // distinct deck paths that have cards
  noteCount: number;
  cardCount: number;
  withHistory: number; // cards carrying scheduling state (not new)
  mediaFiles: string[]; // distinct referenced media filenames
}
