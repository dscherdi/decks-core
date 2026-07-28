import { sampleWithoutReplacement, shuffleInPlace } from "../sampling";

const seeded = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
};

describe("shuffleInPlace", () => {
  it("returns a permutation of the input", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = shuffleInPlace([...items], seeded(42));
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
  });

  it("is deterministic for a fixed rng", () => {
    expect(shuffleInPlace([1, 2, 3, 4, 5], seeded(7))).toEqual(
      shuffleInPlace([1, 2, 3, 4, 5], seeded(7))
    );
  });
});

describe("sampleWithoutReplacement", () => {
  it("samples distinct items", () => {
    const sample = sampleWithoutReplacement([1, 2, 3, 4, 5, 6], 4, seeded(1));
    expect(sample).toHaveLength(4);
    expect(new Set(sample).size).toBe(4);
  });

  it("clamps the count to the pool size", () => {
    expect(sampleWithoutReplacement([1, 2], 10, seeded(1))).toHaveLength(2);
    expect(sampleWithoutReplacement([1, 2], -1, seeded(1))).toHaveLength(0);
  });

  it("does not mutate the input", () => {
    const items = [1, 2, 3];
    sampleWithoutReplacement(items, 2, seeded(3));
    expect(items).toEqual([1, 2, 3]);
  });
});
