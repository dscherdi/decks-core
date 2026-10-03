import { pageFromLabel } from "../pdf/pdf";
import { CARD_DELIMITER, CONCEPT_FORMAT, CONCEPT_RUBRIC } from "./prompts";

/** One examinable thing in a source: what it is, and where it appears. */
export interface SourceConcept {
  term: string;
  page: number;
  blurb: string;
}

export interface ConceptRequest {
  /** Page-labelled source text, as `buildSectionContent` produces it. */
  source: string;
  debug?: boolean;
}

/** Messages for a bring-your-own-key extraction; the backend builds its own. */
export function buildConceptMessages(req: ConceptRequest): {
  system: string;
  user: string;
} {
  return {
    system: `${CONCEPT_RUBRIC}\n\n${CONCEPT_FORMAT}`,
    user: `Here is the source:\n\n${req.source}`,
  };
}

const LABEL_RE = /^\s*(TERM|PAGE|BLURB)\s*:(.*)$/i;

/**
 * Parse the extraction blocks. Forgiving in the same way the critique parser is:
 * a block without a usable term or page is skipped rather than throwing.
 */
export function parseConcepts(text: string): SourceConcept[] {
  const out: SourceConcept[] = [];
  for (const segment of text.split(CARD_DELIMITER)) {
    const buf: Record<"term" | "page" | "blurb", string[]> = {
      term: [],
      page: [],
      blurb: [],
    };
    let current: "term" | "page" | "blurb" | null = null;
    for (const line of segment.split("\n")) {
      const m = LABEL_RE.exec(line);
      if (m) {
        current = m[1].toLowerCase() as "term" | "page" | "blurb";
        buf[current].push(m[2]);
      } else if (current) {
        buf[current].push(line);
      }
    }
    const term = buf.term.join(" ").trim();
    const page = pageFromLabel(buf.page.join(" "));
    if (!term || page === undefined) continue;
    out.push({ term, page, blurb: buf.blurb.join("\n").trim() });
  }
  return out;
}

/**
 * Drop concepts the source never offered, and collapse repeats of the same term
 * on the same page.
 */
export function cleanConcepts(
  concepts: readonly SourceConcept[],
  sourcedPages: ReadonlySet<number>,
): SourceConcept[] {
  const seen = new Set<string>();
  const out: SourceConcept[] = [];
  for (const c of concepts) {
    if (!sourcedPages.has(c.page)) continue;
    const key = `${c.page}:${c.term.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * What a concept's cards are actually doing. Derived, never stored.
 */
export type ConceptState = "no_card" | "thin" | "failing" | "holding";

export interface ConceptCoverage {
  /** How many saved cards cite this concept. */
  cards: number;
  /** Cards that lapse in review or were missed in an exam. */
  failing: number;
  /** Cards the critique found carrying several facts. */
  crammed?: number;
}

/**
 * A concept with cards that keep being got wrong does not want more cards, it
 * wants the ones it has repaired — so failing outranks thin.
 */
export function conceptState(c: ConceptCoverage): ConceptState {
  if (c.cards === 0) return "no_card";
  if (c.failing > 0) return "failing";
  // Thin is one card holding a multi-fact concept, which is what Split answers.
  if (c.cards === 1 && (c.crammed ?? 0) > 0) return "thin";
  return "holding";
}

/** Critique codes that mean a card carries more than one fact. */
export const CRAMMED_CODES: ReadonlySet<string> = new Set(["enumeration", "two_facts"]);

/** Whether any of these rubric codes says the card crams several facts. */
export function isCrammed(codes: readonly string[] | null | undefined): boolean {
  return (codes ?? []).some((c) => CRAMMED_CODES.has(c));
}

/** A card that lapses in review or was got wrong in an exam. */
export function isFailingCard(card: Pick<ConceptCard, "lapses" | "examMisses">): boolean {
  return (card.lapses ?? 0) > 0 || (card.examMisses ?? 0) > 0;
}

export interface ConceptTally {
  no_card: number;
  thin: number;
  failing: number;
  holding: number;
  total: number;
}

export function tallyConcepts(
  coverage: readonly ConceptCoverage[],
): ConceptTally {
  const out: ConceptTally = {
    no_card: 0,
    thin: 0,
    failing: 0,
    holding: 0,
    total: coverage.length,
  };
  for (const c of coverage) out[conceptState(c)] += 1;
  return out;
}

/**
 * How a page reads on the grid. Distinguishes a page with nothing to learn from
 * one carrying concepts nobody has made a card for.
 */
export type PageConceptTone = "strong" | "thin" | "uncovered" | "empty";

export function pageConceptTone(
  extracted: boolean,
  concepts: number,
  cards: number,
): PageConceptTone {
  // Never read, so nothing can be claimed about it either way.
  if (!extracted) return "empty";
  // Extracted and genuinely bare: a solutions page, not a gap.
  if (concepts === 0) return "empty";
  if (cards === 0) return "uncovered";
  return cards >= 3 ? "strong" : "thin";
}

/** A card as the ledger counts it: its text, and its review record if saved. */
export interface ConceptCard {
  /** Front, back and notes joined — everything the term could appear in. */
  text: string;
  /** The staged card's id, when the card can be mapped and the match stored. */
  id?: string;
  front?: string;
  back?: string;
  /** Set when the card was generated for a named concept. */
  conceptId?: string | null;
  /** Lapses on the saved card and its reverse card; 0 for one never reviewed. */
  lapses?: number;
  /** Times the saved card or its reverse card was answered wrong in an exam. */
  examMisses?: number;
  /** The critique found the card carrying several facts. */
  crammed?: boolean;
  /** The source page the card cites, when it carries one. */
  page?: number | null;
  /** The saved flashcard's id, once the card is in a note. */
  flashcardId?: string | null;
}

export interface ConceptRow extends SourceConcept {
  id: string;
  cards: number;
  failing: number;
  crammed: number;
  state: ConceptState;
}

/**
 * The part of a term a card would actually repeat. A qualified term
 * (`Median · robustness`) is matched on its head, which is the word the card
 * carries.
 */
export function conceptNeedle(term: string): string {
  return term
    .split(/[·(]/)[0]
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cardText(card: ConceptCard): string {
  return card.text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Attribute cards to concepts by the term they name, plus any card generated
 * for a concept outright. Text matching is deterministic and free, so it is
 * preferred to a second model pass.
 */
function attributed(
  concept: SourceConcept & { id: string },
  card: ConceptCard,
  text: string,
): boolean {
  const needle = conceptNeedle(concept.term);
  return card.conceptId === concept.id || (needle !== "" && text.includes(needle));
}

export function buildConceptRows(
  concepts: readonly (SourceConcept & { id: string })[],
  cards: readonly ConceptCard[],
): ConceptRow[] {
  const texts = cards.map(cardText);
  return concepts.map((concept) => {
    const { id } = concept;
    let count = 0;
    let failing = 0;
    let crammed = 0;
    cards.forEach((card, i) => {
      if (!attributed(concept, card, texts[i])) return;
      count += 1;
      if (isFailingCard(card)) failing += 1;
      if (card.crammed) crammed += 1;
    });
    return {
      ...concept,
      id,
      cards: count,
      failing,
      crammed,
      state: conceptState({ cards: count, failing, crammed }),
    };
  });
}

/** The cards attributed to any of these concepts, each once, in their own order.
 *  With `failingOnly`, only the ones that lapse. */
export function cardsForConcepts(
  concepts: readonly (SourceConcept & { id: string })[],
  cards: readonly ConceptCard[],
  failingOnly = false,
): ConceptCard[] {
  return cards.filter((card) => {
    if (failingOnly && !isFailingCard(card)) return false;
    const text = cardText(card);
    return concepts.some((concept) => attributed(concept, card, text));
  });
}

export type ConceptFilter = "all" | ConceptState;

export function filterConceptRows(
  rows: readonly ConceptRow[],
  filter: ConceptFilter,
): ConceptRow[] {
  return filter === "all" ? [...rows] : rows.filter((r) => r.state === filter);
}

/** Concepts found on each page, for the grid's middle tone. */
export function conceptsByPage(
  concepts: readonly SourceConcept[],
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of concepts) out[c.page] = (out[c.page] ?? 0) + 1;
  return out;
}

/** A card sent for mapping to the concept it tests. */
export interface ConceptMapCard {
  id: string;
  front: string;
  back: string;
  page?: number;
}

/**
 * Cards the term match did not attribute to any concept, and that have not
 * been mapped yet: the ones worth asking about.
 */
export function unmatchedCards(
  concepts: readonly (SourceConcept & { id: string })[],
  cards: readonly ConceptCard[],
): ConceptMapCard[] {
  const needles = concepts.map((c) => conceptNeedle(c.term)).filter((n) => n !== "");
  const out: ConceptMapCard[] = [];
  for (const card of cards) {
    if (!card.id || card.conceptId) continue;
    const text = cardText(card);
    if (needles.some((n) => text.includes(n))) continue;
    out.push({
      id: card.id,
      front: card.front ?? card.text,
      back: card.back ?? "",
      ...(card.page ? { page: card.page } : {}),
    });
  }
  return out;
}
