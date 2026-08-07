import { sectionsForSelection, pagesForSelection } from "../pdf";
import type { ChapterNode } from "../pdf";

const node = (id: string, startPage: number, endPage: number, children: ChapterNode[] = []): ChapterNode => ({
  id,
  title: id,
  startPage,
  endPage,
  children,
});

// 1-2 parent wrapping two children, plus a sibling.
const tree: ChapterNode[] = [
  node("ch1", 1, 6, [node("ch1.1", 1, 3), node("ch1.2", 4, 6)]),
  node("ch2", 7, 9),
];

describe("sectionsForSelection", () => {
  it("gives each selected leaf its own pages", () => {
    const out = sectionsForSelection(tree, new Set(["ch1.1", "ch2"]));
    expect(out.map((s) => [s.id, s.pages])).toEqual([
      ["ch1.1", [1, 2, 3]],
      ["ch2", [7, 8, 9]],
    ]);
  });

  // The case that would silently double the bill: a parent and its children
  // both ticked means every page is transcribed and sent twice.
  it("never emits a page twice when a parent and its children are both selected", () => {
    const out = sectionsForSelection(tree, new Set(["ch1", "ch1.1", "ch1.2"]));
    const all = out.flatMap((s) => s.pages);
    expect(all.length).toBe(new Set(all).size);
    expect([...all].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // A parent selected alone still contributes everything under it.
  it("keeps a selected parent's uncovered pages", () => {
    const out = sectionsForSelection(tree, new Set(["ch1"]));
    expect(out).toHaveLength(1);
    expect(out[0].pages).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("covers exactly the same pages as pagesForSelection", () => {
    for (const sel of [["ch1"], ["ch1", "ch1.2"], ["ch1.1", "ch2"], ["ch1", "ch2"]]) {
      const ids = new Set(sel);
      const flat = pagesForSelection(tree, ids);
      const split = sectionsForSelection(tree, ids).flatMap((s) => s.pages);
      expect([...split].sort((a, b) => a - b)).toEqual(flat);
    }
  });

  it("returns nothing when nothing is selected", () => {
    expect(sectionsForSelection(tree, new Set())).toEqual([]);
  });
});
