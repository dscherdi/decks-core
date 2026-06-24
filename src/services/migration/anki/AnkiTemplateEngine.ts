/**
 * Deterministic Anki card template engine. Renders a model's `qfmt`/`afmt`
 * (Mustache-style substitution + conditionals) against a note's field data,
 * relying ONLY on the templates to dictate card structure — field names are
 * never special-cased. Pure strings, no DOM. The resolved HTML is returned
 * as-is (markdown conversion happens downstream).
 */

/** Field name → value, mapped from a note's `\x1f`-split `flds`. */
export interface AnkiTemplateData {
  [field: string]: string;
}

export interface AnkiExtraField {
  name: string;
  value: string;
}

export interface AnkiTemplateResult {
  frontHtml: string; // resolved qfmt
  backHtml: string; // resolved afmt, with {{FrontSide}} → frontHtml
  answerHtml: string; // backHtml after <hr id=answer> (answer-only); whole backHtml if absent
  usedFields: string[]; // data fields the templates referenced (substitution or conditional)
  extraFields: AnkiExtraField[]; // referenced-by-nothing fields with a non-empty value
  extraFieldsTable: string; // markdown table of the extra fields (raw values), "" when none
}

// Anki built-in tokens that are not note fields and must never be tracked/extra.
const SPECIAL_TOKENS = new Set([
  "FrontSide",
  "Tags",
  "Type",
  "Card",
  "Deck",
  "Subdeck",
  "CardFlag",
]);

// A field modifier prefix, e.g. {{hint:Field}}, {{type:Field}}, {{cloze:Field}}.
const MODIFIED_TOKEN = /^[a-zA-Z]+:(.+)$/;

const HR_ANSWER = /<hr\s+id\s*=\s*["']?answer["']?\s*\/?>/i;

export class AnkiTemplateEngine {
  static render(qfmt: string, afmt: string, data: AnkiTemplateData): AnkiTemplateResult {
    const used = new Set<string>();

    const frontHtml = AnkiTemplateEngine.resolve(qfmt, data, used);
    // {{FrontSide}} on the back expands to the rendered front (Anki behaviour).
    const afmtWithFront = afmt.replace(/\{\{\s*FrontSide\s*\}\}/g, () => frontHtml);
    const backHtml = AnkiTemplateEngine.resolve(afmtWithFront, data, used);

    const hrMatch = HR_ANSWER.exec(backHtml);
    const answerHtml = hrMatch ? backHtml.slice(hrMatch.index + hrMatch[0].length) : backHtml;

    const usedFields = Array.from(used);
    const extraFields = Object.keys(data)
      .filter((name) => !used.has(name) && (data[name] ?? "").trim().length > 0)
      .map((name) => ({ name, value: data[name] }));

    return {
      frontHtml: frontHtml.trim(),
      backHtml: backHtml.trim(),
      answerHtml: answerHtml.trim(),
      usedFields,
      extraFields,
      extraFieldsTable: AnkiTemplateEngine.buildExtraTable(extraFields),
    };
  }

  // Collapse conditionals, then substitute fields. `used` accumulates every data
  // field the template references (via section OR substitution).
  private static resolve(template: string, data: AnkiTemplateData, used: Set<string>): string {
    const withoutSections = AnkiTemplateEngine.resolveSections(template, data, used);
    return AnkiTemplateEngine.substitute(withoutSections, data, used);
  }

  // Repeatedly resolve the innermost {{#F}}…{{/F}} / {{^F}}…{{/F}} sections until
  // none remain, so nested conditionals collapse correctly.
  private static resolveSections(
    template: string,
    data: AnkiTemplateData,
    used: Set<string>
  ): string {
    // Innermost section: a body containing no further section markers.
    const section = /\{\{([#^])([^}]+)\}\}((?:(?!\{\{[#^/])[\s\S])*?)\{\{\/\s*\2\s*\}\}/;
    let result = template;
    let match = section.exec(result);
    let guard = 0;
    while (match && guard++ < 10000) {
      const [whole, kind, rawField, body] = match;
      const field = rawField.trim();
      AnkiTemplateEngine.track(field, used);
      const filled = (data[field] ?? "").trim().length > 0;
      const keep = kind === "#" ? filled : !filled; // {{#}} when present, {{^}} when absent
      result = result.slice(0, match.index) + (keep ? body : "") + result.slice(match.index + whole.length);
      match = section.exec(result);
    }
    return result;
  }

  // Replace {{Field}} / {{mod:Field}} with the field value (unknown → "").
  private static substitute(template: string, data: AnkiTemplateData, used: Set<string>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_whole, rawToken: string) => {
      const field = AnkiTemplateEngine.fieldName(rawToken);
      if (field === null) return ""; // special token (FrontSide already expanded) → drop
      AnkiTemplateEngine.track(field, used);
      return data[field] ?? "";
    });
  }

  // The underlying data-field name for a token, or null for a special/built-in.
  private static fieldName(rawToken: string): string | null {
    let token = rawToken.trim();
    const modified = MODIFIED_TOKEN.exec(token);
    if (modified) token = modified[1].trim();
    if (SPECIAL_TOKENS.has(token)) return null;
    return token;
  }

  private static track(field: string, used: Set<string>): void {
    if (field && !SPECIAL_TOKENS.has(field)) used.add(field);
  }

  private static buildExtraTable(extraFields: AnkiExtraField[]): string {
    if (extraFields.length === 0) return "";
    const rows = extraFields.map((f) => `| **${f.name}** | ${f.value} |`);
    return ["| Extra Fields | Content |", "| :--- | :--- |", ...rows].join("\n");
  }
}
