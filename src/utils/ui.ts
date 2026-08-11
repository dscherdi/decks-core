/**
 * UI utility functions for preventing blocking operations
 */

/** Longest a yield may wait for a frame before giving up on one. */
const YIELD_FALLBACK_MS = 32;

/**
 * Yield control to the UI thread to prevent blocking. Prefers a frame, so work
 * resumes right after paint; falls back to a timer in Node (tests).
 *
 * The frame is *raced* against a short timer rather than awaited outright:
 * `requestAnimationFrame` never fires while a document is hidden, so a yield in
 * the middle of a write sequence would otherwise hang for as long as the app is
 * backgrounded — leaving, say, a rated card whose review log was never written.
 * Resolving on whichever comes first keeps the sequence moving off-screen while
 * still riding the frame when there is one.
 */
export async function yieldToUI(): Promise<void> {
  await new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(null);
    };
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(finish);
      setTimeout(finish, YIELD_FALLBACK_MS);
    } else {
      setTimeout(finish, 0);
    }
  });
}

/**
 * Yield control every N iterations to prevent blocking during loops
 * @param currentIndex - Current iteration index
 * @param yieldInterval - Yield every N iterations (default: 50)
 */
export async function yieldEvery(
  currentIndex: number,
  yieldInterval = 100
): Promise<void> {
  if (currentIndex > 0 && currentIndex % yieldInterval === 0) {
    await yieldToUI();
  }
}

/**
 * Execute a function with automatic yielding for long-running operations
 * @param items - Array of items to process
 * @param processor - Function to process each item
 * @param yieldInterval - Yield every N items (default: 50)
 */
export async function processWithYielding<T, R>(
  items: T[],
  processor: (item: T, index: number) => R | Promise<R>,
  yieldInterval = 50
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i++) {
    const result = await processor(items[i], i);
    results.push(result);

    await yieldEvery(i, yieldInterval);
  }

  return results;
}
