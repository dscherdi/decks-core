import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "../ai/HttpClient";
import type { AiProviderConfig, RefactorImage } from "../ai/types";
import { AiError } from "../ai/types";
import { createProvider } from "../ai/providers";
import { yieldToUI } from "../../utils/ui";
import { hashImage, type PdfDoc } from "./pdf";

// How many page OCR calls run concurrently (sliding window, no per-batch barrier).
const OCR_CONCURRENCY = 3;

// Bounded retry for a single page's OCR call on transient upstream failures.
const OCR_MAX_ATTEMPTS = 3;
const OCR_RETRY_BASE_MS = 300;

/** Minimal text file store the OCR cache writes to (vault adapter in the plugin). */
export interface FileStore {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** Renders a PDF page to an image (DOM-coupled; injected by the plugin). */
export type PageRenderer = (doc: PdfDoc, pageNum: number) => Promise<RefactorImage>;

/** Reports OCR progress so the UI can show a per-page indicator. */
export interface OcrProgress {
  page: number;
  done: number;
  total: number;
  fromCache: boolean;
}

/** Per-page OCR exchange surfaced to the debug panel (only on a cache miss). */
export interface OcrDebugEntry {
  page: number;
  /** OCR sentinel (`decks-ocr-*`) sent to the backend. */
  model: string;
  system: string;
  user: string;
  /** `data:image/jpeg;base64,…` of the rendered page sent for OCR. */
  imageDataUrl: string;
  raw: string;
}

/**
 * Per-page OCR text store. Renders selected PDF pages to images and transcribes
 * them, caching each page's text under `<pdfHash>/<ocrModel>/<page>.md` — so each
 * tier caches separately and a repeat run reads from disk without a model call.
 */
export class PdfOcrCache {
  constructor(
    private readonly files: FileStore,
    private readonly resolveFolder: () => string,
    private readonly buildConfig: () => Promise<AiProviderConfig>,
    private readonly http: HttpClient,
    private readonly render: PageRenderer,
    private readonly logger?: ILogger,
  ) {}

  private dirPath(pdfHash: string, ocrModel: string): string {
    return `${this.resolveFolder()}/${pdfHash}/${ocrModel}`;
  }

  private pagePath(pdfHash: string, ocrModel: string, pageNum: number): string {
    return `${this.dirPath(pdfHash, ocrModel)}/${pageNum}.md`;
  }

  /** Cached OCR text for a page, or null on a miss. */
  async get(
    pdfHash: string,
    ocrModel: string,
    pageNum: number,
  ): Promise<string | null> {
    const path = this.pagePath(pdfHash, ocrModel, pageNum);
    try {
      if (await this.files.exists(path)) {
        return await this.files.read(path);
      }
    } catch (e) {
      this.logger?.debug(`PDF OCR cache read failed for ${path}: ${String(e)}`);
    }
    return null;
  }

  /** Persist OCR text for a page (overwrites). */
  async set(
    pdfHash: string,
    ocrModel: string,
    pageNum: number,
    text: string,
  ): Promise<void> {
    const path = this.pagePath(pdfHash, ocrModel, pageNum);
    const base = `${this.resolveFolder()}/${pdfHash}`;
    const dir = this.dirPath(pdfHash, ocrModel);
    try {
      if (!(await this.files.exists(base))) await this.files.mkdir(base);
      if (!(await this.files.exists(dir))) await this.files.mkdir(dir);
      await this.files.write(path, text);
    } catch (e) {
      this.logger?.debug(`PDF OCR cache write failed for ${path}: ${String(e)}`);
    }
  }

  /** OCR a single image via the tier's OCR model, retrying transient errors. */
  private async ocrImage(
    image: RefactorImage,
    ocrModel: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const config = await this.buildConfig();
    config.model = ocrModel;
    const provider = createProvider(config, this.http);
    let lastErr: unknown;
    for (let attempt = 0; attempt < OCR_MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new AiError("aborted", "OCR aborted");
      try {
        const raw = await provider.complete({
          system: "",
          user: "",
          images: [image],
          signal,
          json: false,
        });
        return raw.trim();
      } catch (e) {
        // Empty output is a valid blank page; don't treat it as an error.
        if (e instanceof AiError && e.code === "invalid_output") return "";
        lastErr = e;
        const last = attempt === OCR_MAX_ATTEMPTS - 1;
        if (signal?.aborted || last || !isTransient(e)) throw e;
        this.logger?.debug(
          `OCR transient error (attempt ${attempt + 1}), retrying: ${String(e)}`,
        );
        await delay(OCR_RETRY_BASE_MS * (attempt + 1), signal);
      }
    }
    throw lastErr;
  }

  /** Resolve one page: cache hit, or render → OCR → cache (image returned on a miss). */
  private async ocrPage(
    doc: PdfDoc,
    pdfHash: string,
    ocrModel: string,
    pageNum: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; fromCache: boolean; image?: RefactorImage }> {
    const cached = await this.get(pdfHash, ocrModel, pageNum);
    if (cached !== null) return { text: cached, fromCache: true };
    const image = await this.render(doc, pageNum);
    const text = await this.ocrImage(image, ocrModel, signal);
    await this.set(pdfHash, ocrModel, pageNum, text);
    return { text, fromCache: false, image };
  }

  /**
   * OCR a standalone attached image to text, cached by image content + OCR model
   * (reuses the per-page cache with a fixed page index). `onDebug` fires on a miss.
   */
  async ocrImageToText(
    image: RefactorImage,
    ocrModel: string,
    signal?: AbortSignal,
    onDebug?: (e: OcrDebugEntry) => void,
  ): Promise<string> {
    const hash = hashImage(image);
    const cached = await this.get(hash, ocrModel, 0);
    if (cached !== null) return cached;
    const text = await this.ocrImage(image, ocrModel, signal);
    await this.set(hash, ocrModel, 0, text);
    onDebug?.({
      page: 0,
      model: ocrModel,
      system: "(built server-side)",
      user: "(built server-side)",
      imageDataUrl: `data:${image.mimeType};base64,${image.dataBase64}`,
      raw: text,
    });
    return text;
  }

  /**
   * OCR the given pages, returning their text keyed by page number. A sliding-window
   * pool keeps `OCR_CONCURRENCY` pages in flight; cache hits resolve without a call.
   */
  async runOcr(
    doc: PdfDoc,
    pdfHash: string,
    ocrModel: string,
    pages: number[],
    onProgress?: (p: OcrProgress) => void,
    signal?: AbortSignal,
    onDebug?: (e: OcrDebugEntry) => void,
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    let done = 0;
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (!signal?.aborted) {
        const i = nextIndex++;
        if (i >= pages.length) return;
        const pageNum = pages[i];
        try {
          const { text, fromCache, image } = await this.ocrPage(
            doc,
            pdfHash,
            ocrModel,
            pageNum,
            signal,
          );
          out.set(pageNum, text);
          onProgress?.({ page: pageNum, done: ++done, total: pages.length, fromCache });
          if (onDebug && !fromCache && image) {
            onDebug({
              page: pageNum,
              model: ocrModel,
              system: "(built server-side)",
              user: "(built server-side)",
              imageDataUrl: `data:${image.mimeType};base64,${image.dataBase64}`,
              raw: text,
            });
          }
        } catch (e) {
          // Abort stops the run; any other persistent failure degrades the page to
          // empty text so one bad page can't abort the chapter.
          if (signal?.aborted || (e instanceof AiError && e.code === "aborted")) {
            throw e;
          }
          this.logger?.debug(`OCR page ${pageNum} failed, skipping: ${String(e)}`);
          out.set(pageNum, "");
          onProgress?.({
            page: pageNum,
            done: ++done,
            total: pages.length,
            fromCache: false,
          });
        }
        await yieldToUI();
      }
    };

    const poolSize = Math.min(OCR_CONCURRENCY, pages.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    return out;
  }
}

/** Whether an error is worth retrying (rate limit / 5xx / transient network). */
function isTransient(e: unknown): boolean {
  if (!(e instanceof AiError)) return false;
  if (e.code === "rate_limited" || e.code === "network_error") return true;
  return e.status !== undefined && (e.status === 429 || e.status >= 500);
}

/** Sleep that rejects early if the signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new AiError("aborted", "OCR aborted"));
      },
      { once: true },
    );
  });
}
