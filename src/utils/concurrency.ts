/**
 * Run `task` over `items` with at most `limit` invocations in flight at once
 * (a sliding-window pool). Results are returned in input order. Task rejections
 * are not swallowed — the first rejection propagates, so callers that want
 * per-item resilience should catch inside `task`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
