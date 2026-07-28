import { OcclusionV2Parser } from "../OcclusionV2Parser";
import { parseOcclusionBack } from "../OcclusionV2";

const VALID = `
image: "[[anatomy/heart.png]]"
masks:
  - id: m1
    x: 12.5
    y: 30
    w: 18
    h: 9.5
    answer: "Left **ventricle** ($V_L$)"
  - id: m2
    x: 55
    y: 22
    w: 14
    h: 8
    answer: ""
`;

describe("OcclusionV2Parser.parse", () => {
  it("produces one card per mask with shared front/back", () => {
    const cards = OcclusionV2Parser.parse(VALID, "Heart", ["anatomy"]);
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(c.type).toBe("image-occlusion-v2");
      expect(c.front).toBe("![[anatomy/heart.png]]");
      expect(c.imagePath).toBe("anatomy/heart.png");
      expect(c.breadcrumb).toBe("Heart");
      expect(c.tags).toEqual(["anatomy"]);
    }
    expect(cards[0].maskId).toBe("m1");
    expect(cards[0].clozeOrder).toBe(0);
    expect(cards[0].clozeText).toBe("Left **ventricle** ($V_L$)");
    expect(cards[1].maskId).toBe("m2");
    expect(cards[1].clozeText).toBe("");
  });

  it("serializes the full mask set into every card's back (LaTeX preserved)", () => {
    const cards = OcclusionV2Parser.parse(VALID, "", []);
    const doc = parseOcclusionBack(cards[0].back);
    expect(doc).not.toBeNull();
    expect(doc?.masks).toHaveLength(2);
    expect(doc?.masks[0].answer).toContain("$V_L$");
    // Both siblings carry an identical back payload.
    expect(cards[0].back).toBe(cards[1].back);
  });

  it("handles a block with zero masks", () => {
    const cards = OcclusionV2Parser.parse(`image: "[[a.png]]"\nmasks: []`, "", []);
    expect(cards).toHaveLength(0);
  });

  it("returns no cards for malformed YAML and never throws", () => {
    const res = OcclusionV2Parser.parseOcclusionBlock("image: [[a.png]]\n  bad: : :");
    expect(res.ok).toBe(false);
    expect(OcclusionV2Parser.parse("image: [[a.png]]\n  bad: : :", "", [])).toEqual([]);
  });

  it("reports a structured error when image is missing", () => {
    const res = OcclusionV2Parser.parseOcclusionBlock("masks: []");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/image/i);
  });

  it("clamps percentages and normalizes inverted boxes", () => {
    const src = `image: "[[a.png]]"
masks:
  - id: m1
    x: -10
    y: 200
    w: -30
    h: 5`;
    const res = OcclusionV2Parser.parseOcclusionBlock(src);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const m = res.doc.masks[0];
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(100);
      expect(m.w).toBeGreaterThan(0);
      expect(m.x + m.w).toBeLessThanOrEqual(100);
    }
  });

  it("de-duplicates colliding mask ids deterministically", () => {
    const src = `image: "[[a.png]]"
masks:
  - id: dup
    x: 1
    y: 1
    w: 5
    h: 5
  - id: dup
    x: 9
    y: 9
    w: 5
    h: 5`;
    const cards = OcclusionV2Parser.parse(src, "", []);
    const ids = cards.map((c) => c.maskId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("dup");
    expect(ids).toContain("dup-2");
  });

  it("assigns ids to masks that omit them", () => {
    const src = `image: "[[a.png]]"
masks:
  - x: 1
    y: 1
    w: 5
    h: 5`;
    const cards = OcclusionV2Parser.parse(src, "", []);
    expect(cards[0].maskId).toBe("m1");
  });

  it("dumps clean YAML with an unquoted y key that round-trips", () => {
    const doc = {
      __v: 2 as const,
      image: "[[a.png]]",
      masks: [{ id: "m1", x: 77.7, y: 23, w: 15.3, h: 8.2, answer: "" }],
    };
    const yaml = OcclusionV2Parser.toYaml(doc);
    expect(yaml).toMatch(/^\s*y: 23\s*$/m);
    expect(yaml).not.toContain("'y'");
    // Re-parse: the unquoted y is still read as the number 23.
    const reparsed = OcclusionV2Parser.parseOcclusionBlock(yaml);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.doc.masks[0].y).toBe(23);
  });

  it("supports markdown image embeds", () => {
    const cards = OcclusionV2Parser.parse(
      `image: "![alt](images/x.png)"\nmasks:\n  - id: m1\n    x: 1\n    y: 1\n    w: 5\n    h: 5`,
      "",
      [],
    );
    expect(cards[0].front).toBe("![alt](images/x.png)");
    expect(cards[0].imagePath).toBe("images/x.png");
  });
});
