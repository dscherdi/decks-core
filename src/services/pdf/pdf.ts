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

/** Resolve an outline item's destination to its 1-based page number, or null. */
async function destToPage(
  doc: PdfDoc,
  dest: string | unknown[] | null,
): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const index = await doc.getPageIndex(explicit[0]);
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

  const build = async (
    items: OutlineItem[],
    prefix: string,
  ): Promise<ChapterNode[]> => {
    const nodes: ChapterNode[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const startPage = (await destToPage(doc, item.dest)) ?? 1;
      const id = `${prefix}${i}`;
      nodes.push({
        id,
        title: item.title?.trim() || `Section ${i + 1}`,
        startPage,
        endPage: doc.numPages, // patched below
        children: item.items?.length ? await build(item.items, `${id}.`) : [],
      });
    }
    return nodes;
  };

  const tree = await build(outline, "");

  // A node's endPage is one before the next node (in document order) that starts
  // on a later page.
  const flat: ChapterNode[] = [];
  const collect = (nodes: ChapterNode[]): void => {
    for (const n of nodes) {
      flat.push(n);
      collect(n.children);
    }
  };
  collect(tree);
  flat.sort((a, b) => a.startPage - b.startPage);
  for (let i = 0; i < flat.length; i++) {
    let end = doc.numPages;
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j].startPage > flat[i].startPage) {
        end = flat[j].startPage - 1;
        break;
      }
    }
    flat[i].endPage = Math.max(flat[i].startPage, end);
  }
  return tree;
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

/**
 * Resolve the selected pages into a single source string. "text" uses each page's
 * embedded text layer; "ocr" transcribes each page via the injected `ocr` runner.
 * `onProgress(done, total)` fires once per processed page.
 */
export async function buildSectionContent(
  doc: PdfDoc,
  pages: number[],
  mode: PdfParseMode,
  ocr: OcrRunner,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
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

  const parts: string[] = [];
  for (const p of pages) {
    const t = textByPage.get(p);
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

/** Flatten selected chapter ids into the unique, sorted page numbers they cover. */
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
