import {
  formatBadgeLabel,
  formatBadgeParts,
} from "../FilterBadgeFormatter";
import { I18n } from "../../i18n/I18n";
import { DEFAULT_SETTINGS } from "../../settings";
import type { LanguageCode } from "../../i18n/locales";
import type { FilterRule } from "../../database/types";

/**
 * The badge words come from the translation table, so the expectations do too:
 * asserting the English literals would only prove which locale ran the test.
 */
function speak(code: LanguageCode): void {
  I18n.init({ ...DEFAULT_SETTINGS, i18n: { language: code } });
}

const t = (): typeof I18n.t.filterBuilder => I18n.t.filterBuilder;
const m = (): typeof I18n.t.manager => I18n.t.manager;

beforeEach(() => speak("en"));

describe("formatBadgeLabel", () => {
  it("formats state is_new", () => {
    const rule: FilterRule = { field: "state", operator: "is_new", value: "" };
    expect(formatBadgeLabel(rule)).toBe(`${t().fieldState}: ${t().stateNew}`);
  });

  it("formats state is_due", () => {
    const rule: FilterRule = { field: "state", operator: "is_due", value: "" };
    expect(formatBadgeLabel(rule)).toBe(`${t().fieldState}: ${t().fieldDue}`);
  });

  it("formats state equals new and review", () => {
    expect(
      formatBadgeLabel({ field: "state", operator: "equals", value: "new" })
    ).toBe(`${t().fieldState}: ${t().stateNew}`);
    expect(
      formatBadgeLabel({ field: "state", operator: "equals", value: "review" })
    ).toBe(`${t().fieldState}: ${t().stateReview}`);
  });

  it("formats isLeech equals true as the bare word", () => {
    const rule: FilterRule = {
      field: "isLeech",
      operator: "equals",
      value: "true",
    };
    expect(formatBadgeLabel(rule)).toBe(m().badgeLeech);
  });

  it("formats isLeech not_equals true as the negated word", () => {
    const rule: FilterRule = {
      field: "isLeech",
      operator: "not_equals",
      value: "true",
    };
    expect(formatBadgeLabel(rule)).toBe(
      I18n.format(t().badgeNot, { label: m().badgeLeech })
    );
  });

  it("formats isDense equals false as the negated word", () => {
    const rule: FilterRule = {
      field: "isDense",
      operator: "equals",
      value: "false",
    };
    expect(formatBadgeLabel(rule)).toBe(
      I18n.format(t().badgeNot, { label: m().badgeDense })
    );
  });

  it("formats deckTag contains", () => {
    const rule: FilterRule = {
      field: "deckTag",
      operator: "contains",
      value: "german",
    };
    expect(formatBadgeLabel(rule)).toBe(`${t().fieldDeckTag}: "german"`);
  });

  it("formats numeric comparison", () => {
    const rule: FilterRule = {
      field: "lapses",
      operator: "greater_than",
      value: "5",
    };
    expect(formatBadgeLabel(rule)).toBe(`${t().fieldLapses} > 5`);
  });

  it("summarises two decks by name", () => {
    const rule: FilterRule = { field: "deckId", operator: "in", value: "d1,d2" };
    expect(
      formatBadgeLabel(rule, [
        { id: "d1", name: "Math" },
        { id: "d2", name: "Bio" },
      ])
    ).toBe(`${t().fieldDeck}: Math, Bio`);
  });

  it("counts the tail past two decks", () => {
    const rule: FilterRule = {
      field: "deckId",
      operator: "in",
      value: "d1,d2,d3",
    };
    expect(
      formatBadgeLabel(rule, [
        { id: "d1", name: "Math" },
        { id: "d2", name: "Bio" },
        { id: "d3", name: "Chem" },
      ])
    ).toBe(`${t().fieldDeck}: Math +2`);
  });

  it("falls back to raw id when deck not found", () => {
    const rule: FilterRule = {
      field: "deckId",
      operator: "equals",
      value: "missing",
    };
    expect(formatBadgeLabel(rule, [])).toBe(`${t().fieldDeck}: missing`);
  });

  it("formats not_contains for tag", () => {
    const rule: FilterRule = {
      field: "tags",
      operator: "not_contains",
      value: "math",
    };
    expect(formatBadgeLabel(rule)).toBe(
      `${t().fieldTag} ${I18n.format(t().badgeNotText, { value: "math" })}`
    );
  });

  it("formats date before/after", () => {
    expect(
      formatBadgeLabel({
        field: "dueDate",
        operator: "before",
        value: "2026-01-01",
      })
    ).toBe(`${t().fieldDue} ${t().operatorBefore} 2026-01-01`);
    expect(
      formatBadgeLabel({
        field: "lastReviewed",
        operator: "after",
        value: "2026-01-01",
      })
    ).toBe(`${m().colReviewed} ${t().operatorAfter} 2026-01-01`);
  });
});

describe("formatBadgeParts", () => {
  it("returns null key for valueless badges (Leech, Dense)", () => {
    expect(
      formatBadgeParts({
        field: "isLeech",
        operator: "equals",
        value: "true",
      })
    ).toEqual({ key: null, value: m().badgeLeech });
    expect(
      formatBadgeParts({
        field: "isDense",
        operator: "equals",
        value: "true",
      })
    ).toEqual({ key: null, value: m().badgeDense });
  });

  it("returns null key for negated boolean badges", () => {
    expect(
      formatBadgeParts({
        field: "isLeech",
        operator: "not_equals",
        value: "true",
      })
    ).toEqual({
      key: null,
      value: I18n.format(t().badgeNot, { label: m().badgeLeech }),
    });
  });

  // The two fields N33 named: the evaluator has always understood them, but the
  // formatter did not, so they printed their raw field name and `true`.
  it("returns one tinted word for suspended and buried", () => {
    expect(
      formatBadgeParts({
        field: "isSuspended",
        operator: "equals",
        value: "true",
      })
    ).toEqual({ key: null, value: m().suspendedBadge });
    expect(
      formatBadgeParts({ field: "isBuried", operator: "equals", value: "true" })
    ).toEqual({ key: null, value: m().buriedBadge });
  });

  it("negates suspended and buried too", () => {
    expect(
      formatBadgeParts({
        field: "isSuspended",
        operator: "not_equals",
        value: "true",
      })
    ).toEqual({
      key: null,
      value: I18n.format(t().badgeNot, { label: m().suspendedBadge }),
    });
    expect(
      formatBadgeParts({ field: "isBuried", operator: "equals", value: "false" })
    ).toEqual({
      key: null,
      value: I18n.format(t().badgeNot, { label: m().buriedBadge }),
    });
  });

  it("never prints a raw field name for a known field", () => {
    const fields: FilterRule["field"][] = [
      "deckId", "deckTag", "type", "sourceFile", "breadcrumb", "tags",
      "state", "dueDate", "difficulty", "stability", "interval",
      "repetitions", "lapses", "lastReviewed", "created",
      "isLeech", "isDense", "isSuspended", "isBuried",
    ];
    for (const field of fields) {
      const parts = formatBadgeParts({ field, operator: "equals", value: "x" });
      expect(parts.key ?? parts.value).not.toBe(field);
    }
  });

  it("splits state is_new into key/value", () => {
    expect(
      formatBadgeParts({ field: "state", operator: "is_new", value: "" })
    ).toEqual({ key: t().fieldState, value: t().stateNew });
  });

  it("splits state equals into key/value", () => {
    expect(
      formatBadgeParts({ field: "state", operator: "equals", value: "review" })
    ).toEqual({ key: t().fieldState, value: t().stateReview });
  });

  it("encodes operator into the value for numeric comparisons", () => {
    expect(
      formatBadgeParts({
        field: "lapses",
        operator: "greater_than",
        value: "5",
      })
    ).toEqual({ key: t().fieldLapses, value: "> 5" });
    expect(
      formatBadgeParts({
        field: "difficulty",
        operator: "less_than",
        value: "3",
      })
    ).toEqual({ key: t().fieldDifficulty, value: "< 3" });
  });

  it("encodes not_equals operator into the value", () => {
    expect(
      formatBadgeParts({
        field: "tags",
        operator: "not_equals",
        value: "math",
      })
    ).toEqual({ key: t().fieldTag, value: "≠ math" });
  });

  it("wraps contains values in quotes", () => {
    expect(
      formatBadgeParts({
        field: "breadcrumb",
        operator: "contains",
        value: "Chapter 1",
      })
    ).toEqual({ key: t().fieldBreadcrumb, value: '"Chapter 1"' });
  });

  it("formats deckId selection", () => {
    expect(
      formatBadgeParts(
        { field: "deckId", operator: "in", value: "d1,d2,d3" },
        [
          { id: "d1", name: "Math" },
          { id: "d2", name: "Bio" },
          { id: "d3", name: "Chem" },
        ]
      )
    ).toEqual({ key: t().fieldDeck, value: "Math +2" });
  });

  it("shows an em dash when no deck is chosen", () => {
    expect(
      formatBadgeParts({ field: "deckId", operator: "in", value: "" })
    ).toEqual({ key: t().fieldDeck, value: "—" });
  });
});

describe("localisation", () => {
  const CODES: LanguageCode[] = [
    "en", "de", "es", "fr", "it", "ru", "zh", "ja",
    "hi", "sq", "ar", "tr", "zh-TW",
  ];

  it("speaks every locale rather than falling back to English", () => {
    const german = (): string =>
      formatBadgeParts({ field: "state", operator: "is_new", value: "" }).key ??
      "";
    speak("en");
    const english = german();
    speak("de");
    expect(german()).toBe(I18n.t.filterBuilder.fieldState);
    expect(german()).not.toBe(english);
  });

  it("has every word the formatter reads, in all 13 locales", () => {
    for (const code of CODES) {
      speak(code);
      const rules: FilterRule[] = [
        { field: "isLeech", operator: "not_equals", value: "true" },
        { field: "tags", operator: "not_contains", value: "math" },
        { field: "type", operator: "equals", value: "cloze" },
        { field: "interval", operator: "greater_than", value: "5" },
        { field: "repetitions", operator: "less_than", value: "2" },
        { field: "dueDate", operator: "before", value: "2026-01-01" },
      ];
      for (const rule of rules) {
        const line = formatBadgeLabel(rule);
        expect(line).not.toContain("undefined");
        expect(line).not.toContain("{");
      }
    }
  });
});
