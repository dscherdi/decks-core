import { pageMarker } from "../pdf/pdf";

/** A passage selected in a PDF, and the page it was selected on when that is known. */
export interface PassageText {
  text: string;
  page: number | null;
}

/** Below this a selection is a stray drag, not a passage. */
export const MIN_PASSAGE_CHARS = 12;
/** A whole-chapter selection is still one request; cap what it can cost. */
export const MAX_PASSAGE_CHARS = 8000;

/**
 * The rules a raw selection has to satisfy, kept apart from the DOM so they can
 * be tested. A page that cannot be read comes back null, never guessed.
 */
export function passageFrom(raw: string, pageAttr: string | null): PassageText | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < MIN_PASSAGE_CHARS) return null;
  const page = Number.parseInt(pageAttr ?? "", 10);
  return {
    text: text.slice(0, MAX_PASSAGE_CHARS),
    page: Number.isInteger(page) && page > 0 ? page : null,
  };
}

/** The passage as the model should see it, carrying the page it came from. */
export function passageSource(passage: PassageText): string {
  return passage.page ? `${pageMarker(passage.page)}\n${passage.text}` : passage.text;
}
