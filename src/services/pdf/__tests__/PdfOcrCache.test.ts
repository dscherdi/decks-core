import type { AiProviderConfig } from "../../ai/types";
import type { HttpClient } from "../../ai/HttpClient";
import type { RefactorImage } from "../../ai/types";
import { PdfOcrCache, type FileStore, type PageRenderer } from "../PdfOcrCache";
import { hashImage, type PdfDoc } from "../pdf";
import { ocrSentinelForTier, DECKS_TIER_FAST, DECKS_TIER_QUALITY } from "../../ai/models";

/** In-memory FileStore for exercising the cache's file I/O. */
function fakeFiles(): { files: FileStore; store: Map<string, string> } {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  const files: FileStore = {
    exists: async (p) => store.has(p) || dirs.has(p),
    read: async (p) => store.get(p) ?? "",
    write: async (p, data) => void store.set(p, data),
    mkdir: async (p) => void dirs.add(p),
  };
  return { files, store };
}

const noHttp = {} as HttpClient;
const noConfig = (): Promise<AiProviderConfig> =>
  Promise.resolve({ provider: "decks-pro", model: "x", apiKey: "k" });
const noRender: PageRenderer = async () =>
  ({ mimeType: "image/jpeg", dataBase64: "" }) as RefactorImage;

const make = (folder: string, files: FileStore): PdfOcrCache =>
  new PdfOcrCache(files, () => folder, noConfig, noHttp, noRender);

describe("PdfOcrCache get/set", () => {
  const OCR = "decks-ocr-fast";

  it("returns null on a miss and the stored text after a set", async () => {
    const { files } = fakeFiles();
    const cache = make("pdf-ocr", files);
    expect(await cache.get("hash1", OCR, 3)).toBeNull();
    await cache.set("hash1", OCR, 3, "page three text");
    expect(await cache.get("hash1", OCR, 3)).toBe("page three text");
  });

  it("writes per-page files under <folder>/<hash>/<ocrModel>/<page>.md", async () => {
    const { files, store } = fakeFiles();
    const cache = make("cache/pdf", files);
    await cache.set("abc", OCR, 7, "hello");
    expect(store.get(`cache/pdf/abc/${OCR}/7.md`)).toBe("hello");
  });

  // Transcription does not vary with the generation tier, so both tiers now
  // resolve to one sentinel and share one cached page rather than paying twice
  // for identical text.
  it("gives both tiers the same page", async () => {
    const { files } = fakeFiles();
    const cache = make("pdf-ocr", files);
    const forFlash = ocrSentinelForTier(DECKS_TIER_FAST);
    const forThinking = ocrSentinelForTier(DECKS_TIER_QUALITY);

    expect(forFlash).toBe(forThinking);
    await cache.set("h", forFlash, 1, "page text");
    expect(await cache.get("h", forThinking, 1)).toBe("page text");
  });
});

describe("PdfOcrCache.ocrImageToText", () => {
  const OCR = "decks-ocr-fast";
  const image = { mimeType: "image/jpeg", dataBase64: "QUJDREVG" };

  it("returns cached text without invoking the model", async () => {
    const { files } = fakeFiles();
    const cache = make("pdf-ocr", files);
    await cache.set(hashImage(image), OCR, 0, "image text");
    expect(await cache.ocrImageToText(image, OCR)).toBe("image text");
  });
});

describe("PdfOcrCache.runOcr", () => {
  const OCR = "decks-ocr-fast";

  it("serves fully-cached pages without invoking the model", async () => {
    const { files } = fakeFiles();
    const cache = make("pdf-ocr", files);
    await cache.set("h", OCR, 1, "one");
    await cache.set("h", OCR, 2, "two");

    const progress: boolean[] = [];
    const result = await cache.runOcr({} as PdfDoc, "h", OCR, [1, 2], (p) =>
      progress.push(p.fromCache),
    );

    expect(result.get(1)).toBe("one");
    expect(result.get(2)).toBe("two");
    expect(progress).toEqual([true, true]);
  });

  it("returns every page (keyed by page number) for a large cached set", async () => {
    const { files } = fakeFiles();
    const cache = make("pdf-ocr", files);
    const pages = Array.from({ length: 20 }, (_, i) => i + 1);
    for (const p of pages) await cache.set("h", OCR, p, `page-${p}`);

    let done = 0;
    const result = await cache.runOcr({} as PdfDoc, "h", OCR, pages, () => done++);

    expect(result.size).toBe(20);
    for (const p of pages) expect(result.get(p)).toBe(`page-${p}`);
    expect(done).toBe(20);
  });
});
