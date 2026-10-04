import { I18n } from "../../i18n/I18n";
import { formatPageList } from "./coverage";

/** One page of a selection, in reading order, with the section it belongs to. */
export interface ChunkUnit {
  page: number;
  /** Characters the page holds, or an estimate when it has not been read yet. */
  chars: number;
  /** The selected section the page belongs to, when the source has an outline. */
  section?: string;
}

/** A run of pages generated in one request. */
export interface PlannedChunk {
  pages: number[];
  /** Section titles the chunk covers, in order, each once. */
  sections: string[];
}

export interface ChunkPlanOptions {
  /** The first chunk is small so the first cards arrive early. */
  firstChars?: number;
  chars?: number;
}

/** What an unread page is taken to hold when planning before reading. */
export const ESTIMATED_PAGE_CHARS = 2_000;
const FIRST_CHUNK_CHARS = 6_000;
const CHUNK_CHARS = 24_000;
/** Selections above either limit are generated chunk by chunk. */
export const CHUNK_MIN_PAGES = 8;
export const CHUNK_MIN_CHARS = 30_000;

/** Whether a selection is large enough to generate in chunks. */
export function shouldChunk(units: readonly ChunkUnit[]): boolean {
  return units.length > CHUNK_MIN_PAGES || units.reduce((n, u) => n + u.chars, 0) > CHUNK_MIN_CHARS;
}

/**
 * Split a selection into chunks along section boundaries where they fall near
 * the size limit, and between pages otherwise. A page is never split.
 */
export function planChunks(units: readonly ChunkUnit[], opts: ChunkPlanOptions = {}): PlannedChunk[] {
  const firstChars = opts.firstChars ?? FIRST_CHUNK_CHARS;
  const chars = opts.chars ?? CHUNK_CHARS;
  const chunks: PlannedChunk[] = [];
  let pages: number[] = [];
  let sections: string[] = [];
  let size = 0;

  const close = (): void => {
    if (pages.length > 0) chunks.push({ pages, sections });
    pages = [];
    sections = [];
    size = 0;
  };

  let previous: string | undefined;
  for (const unit of units) {
    const limit = chunks.length === 0 ? firstChars : chars;
    const newSection = unit.section !== undefined && unit.section !== previous;
    // A new section starts a new chunk once the current one is half full.
    if (pages.length > 0 && (size + unit.chars > limit || (newSection && size >= limit / 2))) close();
    pages.push(unit.page);
    size += unit.chars;
    if (unit.section !== undefined && !sections.includes(unit.section)) sections.push(unit.section);
    previous = unit.section;
  }
  close();
  return chunks;
}

/** The chunk's name for the progress line: its sections, else its page range. */
export function chunkLabel(chunk: PlannedChunk): string {
  if (chunk.sections.length > 0) {
    return chunk.sections.length === 1 ? chunk.sections[0] : `${chunk.sections[0]} …`;
  }
  const t = I18n.t.modals.aiGenerator;
  return chunk.pages.length === 1
    ? I18n.format(t.pageChip, { page: chunk.pages[0] })
    : I18n.format(t.hub.pages, { range: formatPageList(chunk.pages) });
}
