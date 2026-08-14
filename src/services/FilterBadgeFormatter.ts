import { I18n } from "../i18n/I18n";
import type { FilterRule } from "../database/types";

/**
 * A filter rule as the short words a badge or pill shows.
 *
 * Read from the translation table on every call rather than captured once: the
 * language is resolved after this module loads, and can change afterwards.
 */
function fieldLabels(): Record<string, string> {
  const f = I18n.t.filterBuilder;
  const m = I18n.t.manager;
  return {
    state: f.fieldState,
    dueDate: f.fieldDue,
    deckId: f.fieldDeck,
    deckTag: f.fieldDeckTag,
    tags: f.fieldTag,
    sourceFile: m.colFile,
    breadcrumb: f.fieldBreadcrumb,
    type: f.badgeType,
    difficulty: f.fieldDifficulty,
    stability: f.fieldStability,
    interval: f.badgeInterval,
    repetitions: f.badgeReps,
    lapses: f.fieldLapses,
    lastReviewed: m.colReviewed,
    created: f.fieldCreated,
    isLeech: m.badgeLeech,
    isDense: m.badgeDense,
    isSuspended: m.suspendedBadge,
    isBuried: m.buriedBadge,
  };
}

/** Fields that are a fact about the card, shown as one word rather than a pair. */
const FLAG_FIELDS = new Set([
  "isLeech",
  "isDense",
  "isSuspended",
  "isBuried",
]);

export interface DeckLookup {
  id: string;
  name: string;
}

export interface BadgeParts {
  /** Field label, e.g. "State", "Tag". Null for valueless tokens like "Leech". */
  key: string | null;
  /** The operator+value rendering, e.g. "New", "> 5", "≠ math". */
  value: string;
}

/**
 * Whether a flag rule asserts the flag rather than denies it — which is what
 * decides whether the badge means the thing or its absence, and so how it reads
 * and how it is tinted.
 */
export function isPositiveFlag(rule: FilterRule): boolean {
  return (
    (rule.operator === "equals" && rule.value === "true") ||
    (rule.operator === "not_equals" && rule.value === "false")
  );
}

/** Decks by name, with the tail counted once past two. */
function deckSummary(rule: FilterRule, availableDecks: DeckLookup[]): string | null {
  const ids = rule.value.split(",").filter((v) => v.length > 0);
  if (ids.length === 0) return null;
  const names = ids.map(
    (id) => availableDecks.find((d) => d.id === id)?.name ?? id
  );
  return names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1}`;
}

export function formatBadgeParts(
  rule: FilterRule,
  availableDecks: DeckLookup[] = []
): BadgeParts {
  const t = I18n.t.filterBuilder;
  const labels = fieldLabels();
  const label = labels[rule.field] ?? rule.field;

  if (FLAG_FIELDS.has(rule.field)) {
    return {
      key: null,
      value: isPositiveFlag(rule)
        ? label
        : I18n.format(t.badgeNot, { label }),
    };
  }

  if (rule.field === "deckId") {
    const summary = deckSummary(rule, availableDecks);
    return { key: label, value: summary ?? "—" };
  }

  if (rule.field === "state" && rule.operator === "equals") {
    return {
      key: label,
      value: rule.value === "new" ? t.stateNew : t.stateReview,
    };
  }

  switch (rule.operator) {
    case "is_new":
      return { key: labels.state, value: t.stateNew };
    case "is_due":
      return { key: labels.state, value: t.fieldDue };
    case "equals":
      return { key: label, value: rule.value };
    case "not_equals":
      return { key: label, value: `≠ ${rule.value}` };
    case "contains":
      return { key: label, value: `"${rule.value}"` };
    case "not_contains":
      return { key: label, value: I18n.format(t.badgeNotText, { value: rule.value }) };
    case "greater_than":
      return { key: label, value: `> ${rule.value}` };
    case "less_than":
      return { key: label, value: `< ${rule.value}` };
    case "before":
      return { key: label, value: `${t.operatorBefore} ${rule.value}` };
    case "after":
      return { key: label, value: `${t.operatorAfter} ${rule.value}` };
    case "in":
      return { key: label, value: rule.value };
    default:
      return { key: label, value: rule.value || label };
  }
}

/** The same rule as one line, for surfaces with no room for a key/value split. */
export function formatBadgeLabel(
  rule: FilterRule,
  availableDecks: DeckLookup[] = []
): string {
  const t = I18n.t.filterBuilder;
  const labels = fieldLabels();
  const label = labels[rule.field] ?? rule.field;

  if (FLAG_FIELDS.has(rule.field)) {
    return isPositiveFlag(rule) ? label : I18n.format(t.badgeNot, { label });
  }

  if (rule.field === "deckId") {
    return `${label}: ${deckSummary(rule, availableDecks) ?? "—"}`;
  }

  if (rule.field === "state" && rule.operator === "equals") {
    return `${label}: ${rule.value === "new" ? t.stateNew : t.stateReview}`;
  }

  switch (rule.operator) {
    case "is_new":
      return `${labels.state}: ${t.stateNew}`;
    case "is_due":
      return `${labels.state}: ${t.fieldDue}`;
    case "equals":
      return `${label}: ${rule.value}`;
    case "not_equals":
      return `${label} ≠ ${rule.value}`;
    case "contains":
      return `${label}: "${rule.value}"`;
    case "not_contains":
      return `${label} ${I18n.format(t.badgeNotText, { value: rule.value })}`;
    case "greater_than":
      return `${label} > ${rule.value}`;
    case "less_than":
      return `${label} < ${rule.value}`;
    case "before":
      return `${label} ${t.operatorBefore} ${rule.value}`;
    case "after":
      return `${label} ${t.operatorAfter} ${rule.value}`;
    case "in":
      return `${label}: ${rule.value}`;
    default:
      return rule.value || label;
  }
}
