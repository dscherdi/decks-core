import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const items = [30, 10, 20, 0, 5];
    const results = await mapWithConcurrency(items, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the concurrency limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapWithConcurrency(items, 8, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const seen = new Set<number>();
    const results = await mapWithConcurrency(items, 16, async (n) => {
      seen.add(n);
      return n * 2;
    });
    expect(seen.size).toBe(100);
    expect(results).toEqual(items.map((n) => n * 2));
  });

  it("handles an empty list and a limit larger than the item count", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n + 1)).toEqual([2, 3]);
  });
});
