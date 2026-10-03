import type { RefactorImage } from "../ai/types";

/** A chapter/subchapter node derived from the PDF outline (bookmarks). */
export interface ChapterNode {
  /** Stable id (path through the outline tree). */
  id: string;
  title: string;
  /** 1-based first page of the section. */
  startPage: number;
  /** 1-based last page (inclusive); equals the document end for the last node. */
  endPage: number;
  children: ChapterNode[];
}

// Structural subset of the pdf.js API we depend on (canvasContext kept `unknown`
// so this stays free of DOM types).
interface TextItem {
  str?: string;
}
interface TextContent {
  items: TextItem[];
}
export interface Viewport {
  width: number;
  height: number;
}
export interface RenderTask {
  promise: Promise<void>;
}
export interface PdfPage {
  getViewport(params: { scale: number }): Viewport;
  getTextContent(): Promise<TextContent>;
  render(params: { canvasContext: unknown; viewport: Viewport }): RenderTask;
}
interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineItem[];
}
export interface PdfDoc {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

/** Stable cache key for a PDF's bytes (rolling 32-bit hash, base36). */
export function hashPdf(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hash = 0;
  for (let i = 0; i < view.length; i++) {
    hash = (hash << 5) - hash + view[i];
    hash = hash & hash;
  }
  return `${view.length.toString(36)}_${Math.abs(hash).toString(36)}`;
}

/** Stable cache key for an attached image, hashed over its base64 content. */
export function hashImage(image: RefactorImage): string {
  const s = image.dataBase64;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash = hash & hash;
  }
  return `img_${s.length.toString(36)}_${Math.abs(hash).toString(36)}`;
}

/**
 * Resolve an outline item's destination to its 1-based page number, or null.
 *
 * Returns null rather than a guess when the destination cannot be resolved —
 * bookmarks that carry an action instead of a GoTo, or name a destination the
 * document does not define, are common. Treating those as page 1 would make
 * them claim the front of the document and, because ranges are derived from
 * the ordering, drag every genuine early chapter's range down with them.
 */
async function destToPage(
  doc: PdfDoc,
  dest: string | unknown[] | null,
): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const target = explicit[0];
    // A destination's first element is usually a Ref, but may be a plain page
    // index — getPageIndex throws on the latter, so handle it directly.
    if (typeof target === "number") {
      return target >= 0 && target < doc.numPages ? target + 1 : null;
    }
    const index = await doc.getPageIndex(target);
    return index + 1;
  } catch {
    return null;
  }
}

/** Build the chapter tree from the PDF outline; fixed chunks when there's none. */
export async function extractOutline(doc: PdfDoc): Promise<ChapterNode[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline || outline.length === 0) {
    return fixedChunks(doc.numPages);
  }

  // Page unknown until resolved; null is carried rather than defaulted so the
  // pass below can fill it from context instead of inventing page 1.
  interface Draft {
    node: ChapterNode;
    start: number | null;
    children: Draft[];
  }

  const build = async (items: OutlineItem[], prefix: string): Promise<Draft[]> => {
    const drafts: Draft[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const id = `${prefix}${i}`;
      const children = item.items?.length ? await build(item.items, `${id}.`) : [];
      drafts.push({
        node: {
          id,
          title: item.title?.trim() || `Section ${i + 1}`,
          startPage: 1,
          endPage: doc.numPages,
          children: children.map((c) => c.node),
        },
        start: await destToPage(doc, item.dest),
        children,
      });
    }
    return drafts;
  };

  const drafts = await build(outline, "");

  // Document order, parents before their children — the order the ranges are
  // reasoned about, and not the same as page order once a destination is
  // missing or a bookmark points backwards.
  const flat: Draft[] = [];
  const collect = (list: Draft[]): void => {
    for (const d of list) {
      flat.push(d);
      collect(d.children);
    }
  };
  collect(drafts);

  // An unresolved entry inherits the last known page: it sits somewhere after
  // the previous bookmark, which is a far better guess than the front of the
  // document and keeps document order intact.
  let last = 1;
  for (const d of flat) {
    if (d.start === null) d.start = last;
    else last = d.start;
    d.node.startPage = d.start;
  }

  /**
   * A section runs until the next one begins.
   *
   * `nextStart` is the start of the following section at the same or a shallower
   * level — a parent must span all its children, so it cannot end where its own
   * first child begins.
   */
  const assign = (list: Draft[], nextStart: number): void => {
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      const sibling = i + 1 < list.length ? (list[i + 1].start ?? nextStart) : nextStart;
      d.node.endPage = Math.max(d.node.startPage, sibling - 1);
      assign(d.children, sibling);
    }
  };
  assign(drafts, doc.numPages + 1);

  return drafts.map((d) => d.node);
}

/** Fallback chapter list for outline-less PDFs: fixed 10-page chunks. */
function fixedChunks(numPages: number, size = 10): ChapterNode[] {
  const nodes: ChapterNode[] = [];
  for (let start = 1; start <= numPages; start += size) {
    const end = Math.min(start + size - 1, numPages);
    nodes.push({
      id: `chunk-${start}`,
      title: `Pages ${start}–${end}`,
      startPage: start,
      endPage: end,
      children: [],
    });
  }
  return nodes;
}

/** Extract a page's embedded text layer (the non-OCR path). */
export async function extractPageText(doc: PdfDoc, pageNum: number): Promise<string> {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  return content.items
    .map((it) => it.str ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How a PDF section is turned into text: embedded text, or rendered-page OCR. */
export type PdfParseMode = "text" | "ocr";

/** Runs OCR for the given pages; `onEach` ticks once per page transcribed. */
export type OcrRunner = (
  pagesToOcr: number[],
  onEach?: () => void,
) => Promise<Map<number, string>>;

/** One page of resolved source text, with the page it came from. */
export interface PageText {
  page: number;
  text: string;
}

/** The label preceding each page's text, so a card can report its page. Defined
 *  here because the generation prompt describes this exact shape. */
export function pageMarker(page: number): string {
  return `[p. ${page}]`;
}

const PAGE_VALUE_RE = /^\[?\s*(?:p(?:age)?\.?\s*)?(\d{1,5})\s*\]?$/i;

/** A page named in a model's PAGE field: a bare number, or the marker echoed back. */
export function pageFromLabel(value: string): number | undefined {
  const m = PAGE_VALUE_RE.exec(value.trim());
  const n = m ? Number.parseInt(m[1], 10) : Number.NaN;
  return n > 0 ? n : undefined;
}

/**
 * Resolve the selected pages into per-page source text. "text" uses each page's
 * embedded text layer; "ocr" transcribes each page via the injected `ocr` runner.
 * `onProgress(done, total)` fires once per processed page. Blank pages are dropped.
 */
export async function buildSectionPages(
  doc: PdfDoc,
  pages: number[],
  mode: PdfParseMode,
  ocr: OcrRunner,
  onProgress?: (done: number, total: number) => void,
): Promise<PageText[]> {
  const total = pages.length;
  let done = 0;
  const tick = (): void => {
    done += 1;
    onProgress?.(done, total);
  };

  const textByPage = new Map<number, string>();
  if (mode === "ocr") {
    const ocrText = await ocr(pages, tick);
    for (const [p, t] of ocrText) textByPage.set(p, t);
  } else {
    for (const p of pages) {
      textByPage.set(p, await extractPageText(doc, p));
      tick();
    }
  }

  const out: PageText[] = [];
  for (const p of pages) {
    const text = textByPage.get(p);
    if (text) out.push({ page: p, text });
  }
  return out;
}

/** Resolve the selection into one source string, each page labelled with its
 *  number so a card can cite a page rather than a section index. */
export async function buildSectionContent(
  doc: PdfDoc,
  pages: number[],
  mode: PdfParseMode,
  ocr: OcrRunner,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const resolved = await buildSectionPages(doc, pages, mode, ocr, onProgress);
  return resolved.map((p) => `${pageMarker(p.page)}\n${p.text}`).join("\n\n");
}

/** Flatten selected chapter ids into the unique, sorted page numbers they cover. */
/** A selected chapter and the pages it uniquely contributes. */
export interface SelectedSection {
  id: string;
  title: string;
  pages: number[];
}

/**
 * Selected chapters, each with the pages it alone contributes.
 *
 * `pagesForSelection` returns one flat set, which is all routing needs but
 * loses which chapter a page came from — and without that a card cannot be
 * attributed back to a section. Selecting a parent *and* its children would
 * double-count, so a page belongs to the deepest selected node covering it and
 * a selected parent keeps only what its selected descendants do not claim.
 */
export function sectionsForSelection(
  chapters: ChapterNode[],
  selectedIds: Set<string>,
): SelectedSection[] {
  const out: SelectedSection[] = [];
  const claimed = new Set<number>();

  // Deepest first, so a child claims its pages before its parent is considered.
  const visit = (nodes: ChapterNode[]): void => {
    for (const n of nodes) {
      visit(n.children);
      if (!selectedIds.has(n.id)) continue;
      const pages: number[] = [];
      for (let p = n.startPage; p <= n.endPage; p++) {
        if (claimed.has(p)) continue;
        claimed.add(p);
        pages.push(p);
      }
      if (pages.length > 0) out.push({ id: n.id, title: n.title, pages });
    }
  };
  visit(chapters);

  // Document order reads better than traversal order.
  return out.sort((a, b) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0));
}

export function pagesForSelection(
  chapters: ChapterNode[],
  selectedIds: Set<string>,
): number[] {
  const pages = new Set<number>();
  const walk = (nodes: ChapterNode[]): void => {
    for (const n of nodes) {
      if (selectedIds.has(n.id)) {
        for (let p = n.startPage; p <= n.endPage; p++) pages.add(p);
      }
      walk(n.children);
    }
  };
  walk(chapters);
  return [...pages].sort((a, b) => a - b);
}

/**
 * The deepest chapters covering the given pages. Used to aim a new session at
 * the material a set of pages came from without selecting the whole document.
 */
export function chapterIdsForPages(
  chapters: ChapterNode[],
  pages: readonly number[],
): Set<string> {
  const wanted = new Set(pages);
  const out = new Set<string>();
  const walk = (nodes: ChapterNode[]): boolean => {
    let hit = false;
    for (const node of nodes) {
      const deeper = walk(node.children);
      const covers = [...wanted].some(
        (p) => p >= node.startPage && p <= node.endPage,
      );
      // A parent is only selected when no child of it already covers the page,
      // so the selection stays as narrow as the outline allows.
      if (covers && !deeper) out.add(node.id);
      hit = hit || deeper || covers;
    }
    return hit;
  };
  walk(chapters);
  return out;
}
