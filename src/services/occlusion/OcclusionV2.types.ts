/**
 * Occlusion V2 data model. A `decks-occlusion` codeblock holds the whole model:
 * the image reference plus a list of masks, each with percentage geometry and an
 * optional answer (Markdown/LaTeX). One flashcard is generated per mask.
 */

/** Current occlusion document version embedded in the serialized card back. */
export const OCCLUSION_V2_VERSION = 2 as const;

/** A single masked region. Coordinates are percentages (0-100) of the image. */
export interface OcclusionMask {
  /** Stable id assigned by the studio; identity for the card's FSRS history. */
  id: string;
  /** Left edge, percent of image width (0-100). */
  x: number;
  /** Top edge, percent of image height (0-100). */
  y: number;
  /** Width, percent of image width (0-100). */
  w: number;
  /** Height, percent of image height (0-100). */
  h: number;
  /** Answer shown on the back. Empty string for deletion-only masks. */
  answer: string;
}

/** The full self-contained occlusion model parsed from one codeblock. */
export interface OcclusionDoc {
  __v: typeof OCCLUSION_V2_VERSION;
  /** The image reference exactly as written, e.g. "[[anatomy/heart.png]]". */
  image: string;
  masks: OcclusionMask[];
}

/** Result of parsing a `decks-occlusion` codeblock: either a doc or an error. */
export type OcclusionParseResult =
  | { ok: true; doc: OcclusionDoc }
  | { ok: false; error: string };
