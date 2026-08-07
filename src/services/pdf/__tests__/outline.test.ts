import { extractOutline } from "../pdf";
import type { PdfDoc } from "../pdf";

/**
 * Outline entries the way real PDFs produce them — including the shapes that
 * used to collapse every affected chapter onto page 1.
 */
interface RawItem {
  title: string;
  dest: unknown;
  items?: RawItem[];
}

function docWith(numPages: number, outline: RawItem[]): PdfDoc {
  return {
    numPages,
    async getOutline() {
      return outline;
    },
    async getDestination(name: string) {
      // Only "known" resolves; anything else is a dangling name, as in the wild.
      return name === "known" ? [{ pageIndex: 4 }] : null;
    },
    async getPageIndex(ref: unknown) {
      const r = ref as { pageIndex?: number };
      if (typeof r?.pageIndex !== "number") throw new Error("not a ref");
      return r.pageIndex;
    },
  } as unknown as PdfDoc;
}

const ref = (page: number) => [{ pageIndex: page - 1 }];

describe("extractOutline page ranges", () => {
  // The defect that shipped: a parent ended one page before its own first
  // child, so selecting the chapter transcribed a fraction of its pages.
  it("spans a parent across all of its children", async () => {
    const tree = await extractOutline(
      docWith(20, [
        {
          title: "Ch 1",
          dest: ref(1),
          items: [
            { title: "1.1", dest: ref(1) },
            { title: "1.2", dest: ref(4) },
            { title: "1.3", dest: ref(8) },
          ],
        },
        { title: "Ch 2", dest: ref(13) },
      ]),
    );

    expect(tree[0].startPage).toBe(1);
    expect(tree[0].endPage).toBe(12); // up to Ch 2, not up to 1.2
    expect(tree[0].children.map((c) => [c.startPage, c.endPage])).toEqual([
      [1, 3],
      [4, 7],
      [8, 12],
    ]);
    expect(tree[1]).toMatchObject({ startPage: 13, endPage: 20 });
  });

  // A bookmark carrying an action rather than a GoTo, or naming a destination
  // the document never defines. Defaulting these to page 1 made every one of
  // them claim the front of the document and share one identical range.
  it("does not put unresolvable bookmarks on page 1", async () => {
    const tree = await extractOutline(
      docWith(20, [
        { title: "Ch 1", dest: ref(1) },
        { title: "Broken action", dest: null },
        { title: "Dangling name", dest: "missing" },
        { title: "Ch 2", dest: ref(10) },
      ]),
    );

    expect(tree.map((n) => n.startPage)).toEqual([1, 1, 1, 10]);
    // Crucially the real chapter still spans its own material rather than being
    // truncated to page 0 by a sibling that claimed page 1.
    expect(tree[3]).toMatchObject({ startPage: 10, endPage: 20 });
    expect(tree.every((n) => n.endPage >= n.startPage)).toBe(true);
  });

  // pdf.js destinations sometimes carry a plain page index instead of a Ref;
  // getPageIndex throws on those, which the old code swallowed into page 1.
  it("resolves a numeric page-index destination", async () => {
    const tree = await extractOutline(
      docWith(20, [
        { title: "Ch 1", dest: ref(1) },
        { title: "Ch 2", dest: [7] }, // 0-based index -> page 8
      ]),
    );
    expect(tree[1].startPage).toBe(8);
  });

  it("resolves a named destination", async () => {
    const tree = await extractOutline(docWith(20, [{ title: "Ch", dest: "known" }]));
    expect(tree[0].startPage).toBe(5);
  });

  // A child starting on its parent's own page is extremely common.
  it("keeps a parent and a same-page first child distinct", async () => {
    const tree = await extractOutline(
      docWith(10, [
        { title: "Ch 1", dest: ref(1), items: [{ title: "1.1", dest: ref(1) }] },
        { title: "Ch 2", dest: ref(6) },
      ]),
    );
    expect(tree[0]).toMatchObject({ startPage: 1, endPage: 5 });
    expect(tree[0].children[0]).toMatchObject({ startPage: 1, endPage: 5 });
  });

  it("runs the last section to the end of the document", async () => {
    const tree = await extractOutline(
      docWith(30, [{ title: "A", dest: ref(1) }, { title: "B", dest: ref(20) }]),
    );
    expect(tree[1].endPage).toBe(30);
  });
});
