import type { ResolvedTemplateSet } from "./types";

/**
 * Variable substitution for table templates.
 *
 * Two reference styles are supported simultaneously inside `{{…}}`:
 *  - Positional: `{{1}}`, `{{2}}` → the 1st, 2nd cell (1-based), header names ignored.
 *  - Named:      `{{ColumnName}}` → the cell under the header matching that name
 *                (case-insensitive, whitespace-trimmed).
 * Unknown references resolve to an empty string.
 */

const VARIABLE = /\{\{\s*([^}]+?)\s*\}\}/g;

function resolveVariable(
  token: string,
  cells: string[],
  headers: string[]
): string | undefined {
  if (/^\d+$/.test(token)) {
    const idx = parseInt(token, 10) - 1;
    return idx >= 0 ? cells[idx] : undefined;
  }
  const wanted = token.toLowerCase();
  const headerIdx = headers.findIndex(
    (h) => h.trim().toLowerCase() === wanted
  );
  return headerIdx >= 0 ? cells[headerIdx] : undefined;
}

// A Mustache-style section: `{{#Field}}…{{/Field}}` (shown when the field is
// non-empty) or `{{^Field}}…{{/Field}}` (shown when empty). The body matches the
// innermost section (it contains no further section markers), so a loop collapses
// nested sections from the inside out.
const SECTION = /\{\{\s*([#^])\s*([^}]+?)\s*\}\}((?:(?!\{\{\s*[#^/])[\s\S])*?)\{\{\s*\/\s*\2\s*\}\}/;

function resolveSections(template: string, cells: string[], headers: string[]): string {
  let result = template;
  let match = SECTION.exec(result);
  let guard = 0;
  while (match && guard++ < 10000) {
    const [whole, kind, token, body] = match;
    const value = resolveVariable(token.trim(), cells, headers);
    const filled = value !== undefined && value.trim().length > 0;
    const keep = kind === "#" ? filled : !filled;
    result = result.slice(0, match.index) + (keep ? body : "") + result.slice(match.index + whole.length);
    match = SECTION.exec(result);
  }
  return result;
}

/** Merge a template body with a row's cells, resolving sections then `{{…}}` refs. */
export function mergeTemplate(
  template: string,
  cells: string[],
  headers: string[]
): string {
  const withoutSections = resolveSections(template, cells, headers);
  return withoutSections.replace(VARIABLE, (_match, token: string) => {
    const value = resolveVariable(token, cells, headers);
    return value ?? "";
  });
}

/**
 * List the distinct `{{…}}` variable tokens referenced by a template body.
 * Section markers (`{{#F}}`/`{{^F}}`/`{{/F}}`) are not variables and are skipped.
 */
export function referencedVariables(template: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(VARIABLE.source, "g");
  while ((match = re.exec(template)) !== null) {
    const token = match[1].trim();
    if (/^[#^/]/.test(token)) continue;
    out.push(token);
  }
  return Array.from(new Set(out));
}

/**
 * A table row satisfies a template set when the set has a usable front template
 * that references at least one variable AND every variable the front references
 * resolves to a non-empty cell. Back/notes templates referencing a missing
 * column merge to empty (allowed). Rows that don't satisfy fall back to the
 * default column parsing.
 */
export function templateIsSatisfied(
  set: ResolvedTemplateSet,
  cells: string[],
  headers: string[]
): boolean {
  if (!set.front) return false;
  const vars = referencedVariables(set.front.template);
  if (vars.length === 0) return false;
  return vars.every((token) => {
    const value = resolveVariable(token, cells, headers);
    return value !== undefined && value.trim().length > 0;
  });
}
