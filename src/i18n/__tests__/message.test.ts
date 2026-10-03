import { formatMessage, formatSegments } from "../message";
import { LOCALES } from "../locales";

const CARDS = "{count, plural, one {# card} other {# cards}}";

describe("filling a template", () => {
  it("fills plain placeholders and leaves unknown ones as written", () => {
    expect(formatMessage("Saved to {path} by {who}", { path: "A.md" })).toBe(
      "Saved to A.md by {who}"
    );
  });

  it("picks the language's plural form for a count", () => {
    expect(formatMessage(CARDS, { count: 1 })).toBe("1 card");
    expect(formatMessage(CARDS, { count: 0 })).toBe("0 cards");
    expect(formatMessage(CARDS, { count: 21 })).toBe("21 cards");
  });

  it("follows each language's own categories", () => {
    const ru = "{n, plural, one {# карточка} few {# карточки} many {# карточек} other {# карточки}}";
    expect(formatMessage(ru, { n: 1 }, "ru")).toBe("1 карточка");
    expect(formatMessage(ru, { n: 3 }, "ru")).toBe("3 карточки");
    expect(formatMessage(ru, { n: 5 }, "ru")).toBe("5 карточек");
    expect(formatMessage(ru, { n: 21 }, "ru")).toBe("21 карточка");

    const ar = "{n, plural, zero {لا بطاقات} one {بطاقة واحدة} two {بطاقتان} few {# بطاقات} many {# بطاقة} other {# بطاقة}}";
    expect(formatMessage(ar, { n: 2 }, "ar")).toBe("بطاقتان");
    expect(formatMessage(ar, { n: 4 }, "ar")).toBe("4 بطاقات");

    expect(formatMessage("{n, plural, other {# 枚}}", { n: 1 }, "ja")).toBe("1 枚");
  });

  it("prefers an exact match, and nests placeholders in a branch", () => {
    const t = "{count, plural, =0 {Nothing in {deck}} one {# card in {deck}} other {# cards in {deck}}}";
    expect(formatMessage(t, { count: 0, deck: "Verbs" })).toBe("Nothing in Verbs");
    expect(formatMessage(t, { count: 2, deck: "Verbs" })).toBe("2 cards in Verbs");
  });

  it("falls back to other, and to English rules for an unknown language", () => {
    expect(formatMessage("{n, plural, other {# items}}", { n: 1 })).toBe("1 items");
    expect(formatMessage(CARDS, { count: 1 }, "not-a-language")).toBe("1 card");
  });

  it("keeps the numbers as their own segments, in the sentence's order", () => {
    const pieces = formatSegments(`${CARDS} due in {minutes} min`, { count: 3, minutes: 2 });
    expect(pieces).toEqual([
      { text: "3", value: true, name: "count" },
      { text: " cards due in ", value: false },
      { text: "2", value: true, name: "minutes" },
      { text: " min", value: false },
    ]);
  });
});

describe("every locale's plural blocks", () => {
  it("parse, with a branch for every count", () => {
    for (const [code, table] of Object.entries(LOCALES)) {
      const walk = (node: unknown, path: string): void => {
        if (typeof node === "string") {
          const counts = [...node.matchAll(/\{(\w+)\s*,\s*plural\s*,/g)].map((m) => m[1]);
          if (counts.length === 0) return;
          const params = Object.fromEntries(counts.map((name) => [name, 7]));
          const filled = formatMessage(node, params, code);
          expect({ path, filled }).toEqual({ path, filled: expect.not.stringContaining(", plural,") });
          expect({ path, filled }).toEqual({ path, filled: expect.not.stringContaining("#") });
        } else if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) walk(value, `${code}.${path}.${key}`);
        }
      };
      walk(table, "");
    }
  });
});
