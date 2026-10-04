import { I18n } from "../../i18n/I18n";
import { pageMarker } from "../pdf/pdf";

/**
 * A numbered part of a source: a PDF page, or a section of a note or pasted
 * text. Units are labelled `[p. N]` on the wire whatever they are, so the
 * extraction prompts, the parser and the stored ledger treat them alike.
 */
export interface SourceUnit {
  n: number;
  text: string;
  /** A note section's heading, when it has one. */
  heading?: string;
}

/** Concepts read from a note or pasted text are stored under this prefix plus a content hash. */
export const TEXT_SOURCE_PREFIX = "text:";

/** Whether a stored source key names a PDF, rather than text read without one. */
export function isPdfSourceKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key !== "" && !key.startsWith(TEXT_SOURCE_PREFIX);
}

const MIN_UNIT_CHARS = 400;
const MAX_UNIT_CHARS = 4_000;
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const SECTION_HEADING_RE = /^#{1,3}\s+(.+?)\s*#*\s*$/;

function normalized(text: string): string {
  return text.replace(FRONTMATTER_RE, "").replace(/\r\n?/g, "\n").trim();
}

/** The key a text source's concepts are stored under: changes when the text does. */
export function textSourceKey(text: string): string {
  const s = normalized(text).replace(/\s+/g, " ");
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash = hash & hash;
  }
  return `${TEXT_SOURCE_PREFIX}${s.length.toString(36)}_${Math.abs(hash).toString(36)}`;
}

/** Split a long section between paragraphs; a single paragraph is never cut. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_UNIT_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > MAX_UNIT_CHARS) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * A note as numbered sections: split at its H1–H3 headings, a short section
 * merged into the one after it, a long one split between paragraphs.
 */
export function noteUnits(text: string): SourceUnit[] {
  const sections: Array<{ heading?: string; text: string }> = [];
  for (const line of normalized(text).split("\n")) {
    const heading = SECTION_HEADING_RE.exec(line)?.[1];
    if (heading !== undefined || sections.length === 0) sections.push({ heading, text: "" });
    const last = sections[sections.length - 1];
    last.text = last.text ? `${last.text}\n${line}` : line;
  }

  const merged: Array<{ heading?: string; text: string }> = [];
  let carry: { heading?: string; text: string } | null = null;
  for (const section of sections) {
    const body = section.text.trim();
    if (!body) continue;
    const joined: { heading?: string; text: string } = carry
      ? { heading: carry.heading ?? section.heading, text: `${carry.text}\n\n${body}` }
      : { heading: section.heading, text: body };
    if (joined.text.length < MIN_UNIT_CHARS) carry = joined;
    else {
      merged.push(joined);
      carry = null;
    }
  }
  // A short tail joins the section before it, or stands alone when it is all there is.
  if (carry) {
    const last = merged[merged.length - 1];
    if (last) last.text = `${last.text}\n\n${carry.text}`;
    else merged.push(carry);
  }

  const units: SourceUnit[] = [];
  for (const section of merged) {
    for (const part of splitLong(section.text)) {
      units.push({ n: units.length + 1, text: part, heading: section.heading });
    }
  }
  return units;
}

/** The units as one source, each under its `[p. N]` label. */
export function unitSource(units: readonly SourceUnit[]): string {
  return units.map((u) => `${pageMarker(u.n)}\n${u.text}`).join("\n\n");
}

/** How a unit is named to the reader: "p. 12" for a PDF page, "§3 · Heading" for a section. */
export function unitLabel(n: number, pdf: boolean, heading?: string): string {
  if (pdf) return I18n.format(I18n.t.modals.aiGenerator.pageChip, { page: n });
  return heading ? `§${n} · ${heading}` : `§${n}`;
}
