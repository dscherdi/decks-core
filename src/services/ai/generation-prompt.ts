import type { RefactorImage } from "./types";
import { FLASHCARD_DESIGN_GUIDANCE } from "./refactor-prompt";

/** A single AI-generated flashcard (front/back, with optional notes). */
export interface GeneratedCard {
  front: string;
  back: string;
  notes: string;
}

export interface GenerateRequest {
  /** The user's generation instruction (topic, count, constraints). */
  prompt: string;
  /** Expanded source material (note text, etc.) to ground the generation. */
  sourceContext?: string;
  /** Image attachments to use as source (requires a vision-capable model). */
  images?: RefactorImage[];
  /** When true, the built messages + raw response are attached for debugging. */
  debug?: boolean;
}

/** Delimiter the model emits after each complete card. */
export const CARD_DELIMITER = "===END===";

/**
 * Hardcoded output-format contract appended to the generation system prompt.
 * The model must emit each card as labelled lines terminated by the delimiter,
 * NOT JSON — so the stream can be parsed card-by-card as `===END===` arrives.
 */
const GENERATION_FORMAT = [
  "Output flashcards as plain text in EXACTLY this format, one block per card:",
  "FRONT: <the prompt/question>",
  "BACK: <the answer>",
  "NOTES: <optional extra detail, or leave empty>",
  CARD_DELIMITER,
  "",
  "Rules for the output:",
  `- End every card with a line containing only ${CARD_DELIMITER}.`,
  '- Start each field on its own line with the label "FRONT:", "BACK:", or "NOTES:".',
  "- A field value may span multiple lines and may contain Markdown and $LaTeX$.",
  '- "NOTES:" is optional; include it empty or omit it when there is nothing to add.',
  "- Do not output JSON, numbering, surrounding prose, or code fences — only the card blocks.",
].join("\n");

/** Build the system/user messages for a generation request. */
export function buildGenerationMessages(req: GenerateRequest): {
  system: string;
  user: string;
} {
  const system = `${FLASHCARD_DESIGN_GUIDANCE}\n\n${GENERATION_FORMAT}`;
  let user = req.prompt.trim();
  if (req.sourceContext && req.sourceContext.trim()) {
    user += `\n\nUse the following source material:\n\n${req.sourceContext.trim()}`;
  }
  return { system, user };
}

interface SegmentFields {
  front: string;
  back: string;
  notes: string;
  /** Whether any FRONT/BACK/NOTES label was seen (used for partial cards). */
  started: boolean;
}

const LABEL_RE = /^\s*(FRONT|BACK|NOTES)\s*:(.*)$/i;

/** Parse one card block (text between delimiters) into its fields. */
function parseSegment(segment: string): SegmentFields {
  const buf: Record<"front" | "back" | "notes", string[]> = {
    front: [],
    back: [],
    notes: [],
  };
  let current: "front" | "back" | "notes" | null = null;
  for (const line of segment.split("\n")) {
    const m = LABEL_RE.exec(line);
    if (m) {
      current = m[1].toLowerCase() as "front" | "back" | "notes";
      buf[current].push(m[2]);
    } else if (current) {
      buf[current].push(line);
    }
  }
  return {
    front: buf.front.join("\n").trim(),
    back: buf.back.join("\n").trim(),
    notes: buf.notes.join("\n").trim(),
    started: current !== null,
  };
}

/** A completed card needs at least a front; map fields to a GeneratedCard. */
function toCard(fields: SegmentFields): GeneratedCard | null {
  if (!fields.front) return null;
  return { front: fields.front, back: fields.back, notes: fields.notes };
}

/** Parse a full (non-streamed) response into cards — the fallback path. */
export function parseGeneratedCards(fullText: string): GeneratedCard[] {
  const out: GeneratedCard[] = [];
  for (const segment of fullText.split(CARD_DELIMITER)) {
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

  push(delta: string): {
    completed: GeneratedCard[];
    partial: GeneratedCard | null;
  } {
    this.buffer += delta;
    const completed: GeneratedCard[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf(CARD_DELIMITER)) >= 0) {
      const segment = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + CARD_DELIMITER.length);
      const card = toCard(parseSegment(segment));
      if (card) completed.push(card);
    }
    return { completed, partial: this.peekPartial() };
  }

  /** Flush any complete card left in the buffer when the stream ends. */
  finish(): GeneratedCard | null {
    const card = toCard(parseSegment(this.buffer));
    this.buffer = "";
    return card;
  }

  /** The card currently being streamed (front may still be filling in). */
  private peekPartial(): GeneratedCard | null {
    const fields = parseSegment(this.buffer);
    if (!fields.started) return null;
    return { front: fields.front, back: fields.back, notes: fields.notes };
  }
}
