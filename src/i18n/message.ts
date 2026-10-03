/**
 * Filling translated templates.
 *
 * A template holds `{name}` placeholders and, where a count changes the words
 * around it, ICU-style plural blocks: `{count, plural, one {# card} other {# cards}}`.
 * `#` inside a branch is the count. Branches are chosen with `Intl.PluralRules`
 * for the language, so each locale writes exactly the forms it has (Russian
 * one/few/many/other, Arabic up to six, Japanese only other); `=0` matches exactly.
 */

export interface MessageSegment {
  text: string;
  /** Set when this piece was a filled value — a caller may emphasise it. */
  value: boolean;
  /** The placeholder's name, so a caller can style each one differently. */
  name?: string;
}

export type MessageParams = Record<string, string | number>;

const rulesByLocale = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string): Intl.PluralRules {
  let rules = rulesByLocale.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules("en");
    }
    rulesByLocale.set(locale, rules);
  }
  return rules;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The branches of a plural block, as selector → text. */
function pluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const selector = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/.exec(body.slice(i));
    if (!selector) break;
    const open = i + selector[0].length - 1;
    const close = closingBrace(body, open);
    if (close < 0) break;
    branches.set(selector[1], body.slice(open + 1, close));
    i = close + 1;
  }
  return branches;
}

function pickBranch(body: string, count: number, locale: string): string | null {
  const branches = pluralBranches(body);
  return (
    branches.get(`=${count}`) ??
    branches.get(pluralRules(locale).select(count)) ??
    branches.get("other") ??
    null
  );
}

function push(out: MessageSegment[], segment: MessageSegment): void {
  const last = out[out.length - 1];
  if (!segment.value && last && !last.value) last.text += segment.text;
  else if (segment.value || segment.text) out.push(segment);
}

/** The filled template in pieces, in the translation's own order. */
export function formatSegments(
  template: string,
  params: MessageParams,
  locale = "en"
): MessageSegment[] {
  const out: MessageSegment[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      push(out, { text: template.slice(i), value: false });
      break;
    }
    if (open > i) push(out, { text: template.slice(i, open), value: false });
    const close = closingBrace(template, open);
    if (close < 0) {
      push(out, { text: template.slice(open), value: false });
      break;
    }
    const inner = template.slice(open + 1, close);
    const simple = /^(\w+)$/.exec(inner);
    const plural = /^(\w+)\s*,\s*plural\s*,/.exec(inner);
    if (simple && simple[1] in params) {
      push(out, { text: String(params[simple[1]]), value: true, name: simple[1] });
    } else if (plural && plural[1] in params) {
      const name = plural[1];
      const branch = pickBranch(inner.slice(plural[0].length), Number(params[name]), locale);
      if (branch === null) {
        push(out, { text: template.slice(open, close + 1), value: false });
      } else {
        const filled = formatSegments(branch.replace(/#/g, `{${name}}`), params, locale);
        for (const segment of filled) push(out, { ...segment });
      }
    } else {
      push(out, { text: template.slice(open, close + 1), value: false });
    }
    i = close + 1;
  }
  return out;
}

/** The filled template. Unknown placeholders are left as written. */
export function formatMessage(template: string, params: MessageParams, locale = "en"): string {
  return formatSegments(template, params, locale)
    .map((segment) => segment.text)
    .join("");
}
