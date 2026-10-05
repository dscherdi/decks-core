import type { RefactorImage } from "./types";
import { pageFromLabel } from "../pdf/pdf";
import { isDelimiterLine, labelReader, mayBecomeMarker } from "./reply-labels";
import {
  CARD_DELIMITER,
  MCQ_FORMAT,
  COVERED_MARKER,
  CONTINUE_TRIGGER,
  REFINE_TRIGGER,
  DECKS_OVERVIEW,
  DEDUP_RULE,
  GENERATION_FORMAT,
} from "./prompts";

export { CARD_DELIMITER, COVERED_MARKER };

/** A single AI-generated flashcard (front/back, with optional notes). */
export interface GeneratedCard {
  front: string;
  back: string;
  notes: string;
  /** 1-based index of the labelled source section this came from, when known. */
  section?: number;
  /** The source page this came from. Unlike `section`, it is checkable. */
  page?: number;
}

export interface GenerateRequest {
  /** The user's generation instruction (topic, count, constraints). */
  prompt: string;
  /** Expanded source material (note text, etc.) to ground the generation. */
  sourceContext?: string;
  /** Image attachments to use as source (requires a vision-capable model). */
  images?: RefactorImage[];
  /**
   * Cards already produced for this source, fed back as an assistant turn so an
   * iterative batch continues without duplicates. Omit/empty on the first batch.
   */
  generatedSoFar?: GeneratedCard[];
  /** The round a refining instruction replaces. The reply rewrites these cards
   *  rather than adding to them. */
  refining?: GeneratedCard[];
  /** When true, the built messages + raw response are attached for debugging. */
  debug?: boolean;
  /** Optional routing-category hint forwarded to the backend (Decks Pro). */
  category?: string;
  /** What to generate. Omitted or "basic" produces ordinary flashcards. */
  cardType?: GeneratedCardType;
}

/** What a generation run is asked to produce. */
export type GeneratedCardType = "basic" | "mcq";

/** How many prior cards a round names as covered; older ones still count for deduplication. */
export const PRIOR_CARD_LIMIT = 60;
const PRIOR_FRONT_CHARS = 200;

/** The prior cards as a list of fronts the model must not repeat, or "" for none. */
export function coveredList(cards: readonly GeneratedCard[] | undefined): string {
  const fronts = (cards ?? [])
    .map((card) => card.front.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-PRIOR_CARD_LIMIT)
    .map((front) => (front.length > PRIOR_FRONT_CHARS ? `${front.slice(0, PRIOR_FRONT_CHARS - 1)}…` : front));
  if (!fronts.length) return "";
  return `Already covered — do not repeat these:\n${fronts.map((front) => `- ${front}`).join("\n")}`;
}

/** Render prior cards back into the model's own output grammar, page included so a rewrite keeps it. */
export function serializeCards(cards: GeneratedCard[]): string {
  return cards
    .map((c) => {
      const lines = [`FRONT: ${c.front}`, `BACK: ${c.back}`];
      if (c.notes) lines.push(`NOTES: ${c.notes}`);
      if (c.page) lines.push(`PAGE: ${c.page}`);
      lines.push(CARD_DELIMITER);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Build the message parts for a generation request as a cache-friendly sequence:
 * a static system prompt, a static first user message (the source notes), and a
 * trailing user message carrying what is already covered, the instruction and the
 * continue trigger. Keeping the source notes in their own static block lets the
 * system+user prefix be cached across batches.
 *
 * When there is no source material the structure degrades to a single user
 * message (the instruction), matching the original prompt-only behaviour.
 */
export function buildGenerationMessages(req: GenerateRequest): {
  system: string;
  user: string;
  priorAssistant?: string;
  followupUser?: string;
} {
  const system =
    req.cardType === "mcq"
      ? `${DECKS_OVERVIEW}\n\n${MCQ_FORMAT}\n\n${GENERATION_FORMAT}\n\n${DEDUP_RULE}`
      : `${DECKS_OVERVIEW}\n\n${GENERATION_FORMAT}\n\n${DEDUP_RULE}`;
  const source = req.sourceContext?.trim();
  const instruction = req.prompt.trim();
  if (req.refining?.length) {
    return {
      system,
      user: source ? `Here are the source notes:\n\n${source}` : "Here are flashcards to revise.",
      priorAssistant: `Here are the cards to revise:\n\n${serializeCards(req.refining)}`,
      followupUser: `${instruction}\n\n${REFINE_TRIGGER}`,
    };
  }
  const covered = coveredList(req.generatedSoFar);

  if (!source) {
    // No source notes: one message, the covered list ahead of the instruction.
    return { system, user: [covered, instruction || CONTINUE_TRIGGER].filter(Boolean).join("\n\n") };
  }

  const user = `Here are the source notes:\n\n${source}`;
  const followupUser = [covered, instruction, CONTINUE_TRIGGER].filter(Boolean).join("\n\n");
  return { system, user, followupUser };
}

interface SegmentFields {
  front: string;
  back: string;
  notes: string;
  /** The source section index the model attributed this card to, if any. */
  section: string;
  /** The source page the model attributed this card to, if any. */
  page: string;
  /** Whether any FRONT/BACK/NOTES label was seen (used for partial cards). */
  started: boolean;
}

type Label = "front" | "back" | "notes" | "section" | "page";

const LABEL_NAMES = ["FRONT", "BACK", "NOTES", "SECTION", "PAGE"] as const;
const readLabel = labelReader(LABEL_NAMES);

/** The label a line opens, with the rest of the line, or null for a continuation line. */
function labelOf(line: string): { label: Label; rest: string } | null {
  const m = readLabel(line);
  return m ? { label: m.name.toLowerCase() as Label, rest: m.rest } : null;
}

/**
 * Rewrite delimiter variants to the delimiter, and close a card that a new FRONT
 * starts after its BACK without one. Only whole lines are rewritten unless `final`.
 */
function normalizeReply(text: string, final: boolean): string {
  const lines = text.split("\n");
  const tail = final ? null : (lines.pop() ?? "");
  const out: string[] = [];
  let sawBack = false;
  for (const line of lines) {
    if (isDelimiterLine(line)) {
      out.push(CARD_DELIMITER);
      sawBack = false;
      continue;
    }
    if (line.includes(CARD_DELIMITER)) {
      out.push(line);
      sawBack = false;
      continue;
    }
    const label = labelOf(line)?.label;
    if (label === "front" && sawBack) {
      out.push(CARD_DELIMITER);
      sawBack = false;
    }
    if (label === "back") sawBack = true;
    out.push(line);
  }
  if (tail !== null) out.push(tail);
  return out.join("\n");
}

/** Parse one card block (text between delimiters) into its fields. */
function parseSegment(segment: string): SegmentFields {
  const buf: Record<Label, string[]> = {
    front: [],
    back: [],
    notes: [],
    section: [],
    page: [],
  };
  let current: Label | null = null;
  for (const line of segment.split("\n")) {
    const m = labelOf(line);
    if (m) {
      current = m.label;
      buf[current].push(m.rest);
    } else if (current) {
      buf[current].push(line);
    }
  }
  return {
    front: buf.front.join("\n").trim(),
    back: buf.back.join("\n").trim(),
    notes: buf.notes.join("\n").trim(),
    section: buf.section.join("\n").trim(),
    page: buf.page.join("\n").trim(),
    started: current !== null,
  };
}

/** A completed card needs at least a front; map fields to a GeneratedCard. */
function toCard(fields: SegmentFields): GeneratedCard | null {
  if (!fields.front) return null;
  // An index, not a title: the model echoing a heading invites paraphrase, and
  // an out-of-range or absent value simply means unattributed.
  const n = Number.parseInt(fields.section, 10);
  const section = Number.isInteger(n) && n > 0 ? n : undefined;
  // The model echoes a page label we wrote into the source, so a value outside the
  // labelled range is a hallucination; the caller clamps it against the selection.
  const page = pageFromLabel(fields.page);
  return { front: fields.front, back: fields.back, notes: fields.notes, section, page };
}

/** Parse a full (non-streamed) response into cards — the fallback path. */
export function parseGeneratedCards(fullText: string): GeneratedCard[] {
  const out: GeneratedCard[] = [];
  const text = normalizeReply(fullText.split(COVERED_MARKER).join(""), true);
  for (const segment of text.split(CARD_DELIMITER)) {
    const card = toCard(parseSegment(segment));
    if (card) out.push(card);
  }
  return out;
}

/**
 * Incremental parser for streamed generation. Feed text deltas via `push`; it
 * returns any cards completed by that delta plus the in-progress `partial` card
 * (so the UI can render the card currently being typed). Call `finish` at the
 * end to flush a trailing complete card the model didn't terminate.
 */
export class GenerationStreamParser {
  private buffer = "";
  /** Set once the model signals the source is exhausted. */
  covered = false;

  push(delta: string): {
    completed: GeneratedCard[];
    partial: GeneratedCard | null;
  } {
    this.buffer += delta;
    // Strip the marker before card parsing so it can never leak into a card.
    if (this.buffer.includes(COVERED_MARKER)) {
      this.covered = true;
      this.buffer = this.buffer.split(COVERED_MARKER).join("");
    }
    this.buffer = normalizeReply(this.buffer, false);
    const completed: GeneratedCard[] = [];
    let idx: number;
    // Only within finished lines: a delimiter line may still gain its closing marks.
    while ((idx = this.buffer.indexOf(CARD_DELIMITER)) >= 0 && this.buffer.indexOf("\n", idx) >= 0) {
      const segment = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + CARD_DELIMITER.length);
      const card = toCard(parseSegment(segment));
      if (card) completed.push(card);
    }
    return { completed, partial: this.peekPartial() };
  }

  /** Flush the cards left in the buffer when the stream ends; the last one may be unterminated. */
  finish(): GeneratedCard[] {
    const segments = normalizeReply(this.buffer, true).split(CARD_DELIMITER);
    this.buffer = "";
    return segments.map((segment) => toCard(parseSegment(segment))).filter((c): c is GeneratedCard => c !== null);
  }

  /** The card currently being streamed (front may still be filling in). */
  private peekPartial(): GeneratedCard | null {
    // A last line still arriving may be the start of the next label, which is not the card's text.
    const cut = this.buffer.lastIndexOf("\n");
    const tail = this.buffer.slice(cut + 1);
    const settled = cut >= 0 && mayBecomeMarker(tail, LABEL_NAMES) ? this.buffer.slice(0, cut) : this.buffer;
    const fields = parseSegment(settled);
    if (!fields.started) return null;
    return { front: fields.front, back: fields.back, notes: fields.notes };
  }
}
