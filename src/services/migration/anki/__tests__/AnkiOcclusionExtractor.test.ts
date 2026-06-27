import { AnkiOcclusionExtractor } from "../AnkiOcclusionExtractor";

describe("AnkiOcclusionExtractor", () => {
  it("converts SVG rects (pixels) to percent masks", () => {
    const svg =
      '<svg width="151" height="68"><g><title>Masks</title>' +
      '<rect class="qshape" id="oa-1" x="77.5" y="15" width="68" height="34"/></g></svg>';
    const result = AnkiOcclusionExtractor.extract(svg);
    expect(result?.width).toBe(151);
    expect(result?.height).toBe(68);
    expect(result?.masks).toHaveLength(1);
    const m = result!.masks[0];
    expect(m.id).toBe("oa-1");
    expect(m.x).toBeCloseTo((77.5 / 151) * 100, 2);
    expect(m.y).toBeCloseTo((15 / 68) * 100, 2);
    expect(m.w).toBeCloseTo((68 / 151) * 100, 2);
    expect(m.h).toBeCloseTo((34 / 68) * 100, 2);
    expect(m.answer).toBe("");
  });

  it("reads dimensions from viewBox when width/height are absent", () => {
    const svg = '<svg viewBox="0 0 200 100"><rect id="a" x="100" y="50" width="20" height="10"/></svg>';
    const result = AnkiOcclusionExtractor.extract(svg);
    expect(result?.masks[0]).toMatchObject({ x: 50, y: 50, w: 10, h: 10 });
  });

  it("extracts multiple rects in order", () => {
    const svg =
      '<svg width="100" height="100">' +
      '<rect id="a" x="0" y="0" width="10" height="10"/>' +
      '<rect id="b" x="50" y="50" width="10" height="10"/></svg>';
    const result = AnkiOcclusionExtractor.extract(svg);
    expect(result?.masks.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns null for an SVG without usable dimensions or rects", () => {
    expect(AnkiOcclusionExtractor.extract('<svg width="100" height="100"></svg>')).toBeNull();
    expect(AnkiOcclusionExtractor.extract("<rect x='1' y='1' width='1' height='1'/>")).toBeNull();
    expect(AnkiOcclusionExtractor.extract("")).toBeNull();
  });
});
