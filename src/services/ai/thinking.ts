/** The tail kept of a round's thinking; older text is dropped, never stored. */
export const THINKING_CAP = 16_000;
const FLUSH_MS = 80;

/**
 * Thinking text as it streams, batched so a token-by-token feed redraws a few
 * times a second rather than on every delta.
 */
export class ThinkingBuffer {
  private text = "";
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onFlush: (text: string) => void) {}

  push(delta: string): void {
    this.pending += delta;
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    this.text = (this.text + this.pending).slice(-THINKING_CAP);
    this.pending = "";
    this.onFlush(this.text);
  }

  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = "";
    this.text = "";
    this.onFlush("");
  }
}
