import { chapterIdsForPages } from "../pdf";
import type { ChapterNode } from "../pdf";

const node = (
  id: string,
  startPage: number,
  endPage: number,
  children: ChapterNode[] = [],
): ChapterNode => ({ id, title: id, startPage, endPage, children });

describe("chapterIdsForPages", () => {
  const outline = [
    node("ch1", 55, 75, [node("ch1a", 55, 67), node("ch1b", 68, 75)]),
    node("ch2", 76, 92),
  ];

  it("selects the deepest chapter covering a page", () => {
    expect([...chapterIdsForPages(outline, [70])]).toEqual(["ch1b"]);
  });

  it("selects a leaf chapter with no children of its own", () => {
    expect([...chapterIdsForPages(outline, [80])]).toEqual(["ch2"]);
  });

  it("selects every chapter the pages reach", () => {
    expect([...chapterIdsForPages(outline, [60, 80])].sort()).toEqual([
      "ch1a",
      "ch2",
    ]);
  });

  it("selects nothing for a page outside the outline", () => {
    expect(chapterIdsForPages(outline, [500]).size).toBe(0);
  });
});
