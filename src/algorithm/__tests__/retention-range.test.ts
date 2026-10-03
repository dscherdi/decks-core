import { FSRS } from "../fsrs";
import { REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN, validateRequestRetention } from "../fsrs-weights";
import { LOCALES } from "../../i18n/locales";
import type { Flashcard } from "../../database/types";

const NOW = new Date(2026, 0, 15, 12);

const card: Flashcard = {
  id: "c",
  deckId: "d",
  front: "Q",
  back: "A",
  type: "header-paragraph",
  sourceFile: "d.md",
  contentHash: "h",
  breadcrumb: "",
  notes: "",
  tags: [],
  hint: "",
  suspendedAt: null,
  buriedUntil: null,
  clozeText: null,
  clozeOrder: null,
  anchor: null,
  state: "review",
  dueDate: NOW.toISOString(),
  interval: 1440 * 3,
  repetitions: 3,
  stability: 3,
  difficulty: 5,
  lapses: 0,
  lastReviewed: new Date(NOW.getTime() - 3 * 86400000).toISOString(),
  created: NOW.toISOString(),
  modified: NOW.toISOString(),
};

describe("the retention range", () => {
  it("is 0.5 to 0.995, both ends included", () => {
    expect([REQUEST_RETENTION_MIN, REQUEST_RETENTION_MAX]).toEqual([0.5, 0.995]);
    for (const ok of [0.5, 0.9, 0.995]) expect(validateRequestRetention(ok)).toBe(true);
    for (const bad of [0.4999, 0.9951, 0, 1, NaN, Infinity]) expect(validateRequestRetention(bad)).toBe(false);
  });

  it("schedules at either end, longer at the lower target", () => {
    const interval = (requestRetention: number) =>
      new FSRS({ requestRetention, profile: "STANDARD", nextDayStartsAt: 4 }).updateCard(card, "good", NOW).interval;
    const low = interval(REQUEST_RETENTION_MIN);
    const high = interval(REQUEST_RETENTION_MAX);
    expect(Number.isFinite(low) && Number.isFinite(high)).toBe(true);
    expect(low).toBeGreaterThan(interval(0.9));
    expect(high).toBeLessThan(interval(0.9));
    expect(high).toBeGreaterThanOrEqual(1);
  });

  it("refuses a target just outside, naming the range", () => {
    for (const requestRetention of [0.4999, 0.9951]) {
      expect(() => new FSRS({ requestRetention })).toThrow("[0.5, 0.995]");
      expect(() => new FSRS().updateParameters({ requestRetention })).toThrow("[0.5, 0.995]");
    }
  });

  it("is the range every locale's profile text names", () => {
    const named = (text: string) => (text.match(/\d+[.,]\d+/g) ?? []).map((n) => Number(n.replace(",", ".")));
    for (const [code, t] of Object.entries(LOCALES)) {
      for (const text of [t.profiles.requestRetentionDesc, t.profiles.retentionDesc, t.profiles.noticeRequestRetentionRange]) {
        expect({ code, range: named(text) }).toEqual({ code, range: [REQUEST_RETENTION_MIN, REQUEST_RETENTION_MAX] });
      }
    }
  });
});
