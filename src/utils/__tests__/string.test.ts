import { levenshteinSimilarity, levenshteinSimilarityAbove } from "../string";

describe("levenshteinSimilarity", () => {
  it("returns 100 for identical strings and 0 against empty", () => {
    expect(levenshteinSimilarity("chien", "chien")).toBe(100);
    expect(levenshteinSimilarity("", "")).toBe(100);
    expect(levenshteinSimilarity("chien", "")).toBe(0);
    expect(levenshteinSimilarity("", "chien")).toBe(0);
  });

  it("computes classic distances (rolling-row implementation)", () => {
    // kitten→sitting: distance 3, maxLen 7 → (7-3)/7 ≈ 57.14
    expect(levenshteinSimilarity("kitten", "sitting")).toBeCloseTo((4 / 7) * 100, 5);
    // 1 substitution in 5 chars → 80
    expect(levenshteinSimilarity("chien", "chuen")).toBe(80);
    // unicode: accents count as ordinary characters
    expect(levenshteinSimilarity("étude", "etude")).toBe(80);
  });

  it("is symmetric", () => {
    expect(levenshteinSimilarity("weather", "whether")).toBe(
      levenshteinSimilarity("whether", "weather")
    );
  });
});

describe("levenshteinSimilarityAbove", () => {
  it("agrees with the full computation on and around the threshold", () => {
    const pairs: Array<[string, string]> = [
      ["chien", "chuen"], // exactly 80 → NOT above
      ["weather", "wether"], // 6/7 ≈ 85.7 → above
      ["kitten", "sitting"], // ≈57 → not above
      ["la maison", "la maison!"], // 90 → above
      ["être", "etre"], // 3/5=60... distance(être,etre): substitution ê→e =1? è..; compute via full
    ];
    for (const [a, b] of pairs) {
      expect(levenshteinSimilarityAbove(a, b, 80)).toBe(levenshteinSimilarity(a, b) > 80);
    }
  });

  it("length-ratio pre-filter rejects without computing (short vs long)", () => {
    // minLen/maxLen = 3/30 = 10% ≤ 80 → impossible to exceed 80
    expect(levenshteinSimilarityAbove("cat", "a much longer unrelated front", 80)).toBe(false);
  });

  it("early-exit path still accepts near-identical long strings", () => {
    const base = "the quick brown fox jumps over the lazy dog";
    expect(levenshteinSimilarityAbove(base, base + "s", 80)).toBe(true);
    expect(levenshteinSimilarityAbove(base, "completely different sentence here ok", 80)).toBe(
      levenshteinSimilarity(base, "completely different sentence here ok") > 80
    );
  });

  it("handles empty inputs like the full computation", () => {
    expect(levenshteinSimilarityAbove("", "", 80)).toBe(true); // 100 > 80
    expect(levenshteinSimilarityAbove("x", "", 80)).toBe(false);
  });
});
