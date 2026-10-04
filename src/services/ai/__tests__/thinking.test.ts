import { ThinkingBuffer, THINKING_CAP } from "../thinking";

describe("the thinking buffer", () => {
  afterEach(() => jest.useRealTimers());

  it("shows a burst of deltas in one update, not one per token", () => {
    jest.useFakeTimers();
    const shown: string[] = [];
    const buffer = new ThinkingBuffer((t) => shown.push(t));
    for (const t of ["Let ", "me ", "see"]) buffer.push(t);
    expect(shown).toEqual([]);
    jest.advanceTimersByTime(100);
    expect(shown).toEqual(["Let me see"]);
  });

  it("keeps only the newest text past the cap", () => {
    let shown = "";
    const buffer = new ThinkingBuffer((t) => (shown = t));
    buffer.push("a".repeat(THINKING_CAP));
    buffer.push("tail");
    buffer.flush();
    expect(shown).toHaveLength(THINKING_CAP);
    expect(shown.endsWith("tail")).toBe(true);
  });

  it("starts empty for the next round, dropping what was still queued", () => {
    jest.useFakeTimers();
    let shown = "x";
    const buffer = new ThinkingBuffer((t) => (shown = t));
    buffer.push("old");
    buffer.flush();
    buffer.push("queued");
    buffer.reset();
    jest.advanceTimersByTime(100);
    expect(shown).toBe("");
  });
});
