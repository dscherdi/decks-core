import type {
  DeckTemplate,
  TemplateRow,
  TemplateFaceType,
} from "../../database/types";
import { mergeTemplate } from "./TemplateMerger";

/** The merged, ready-to-render output for a card whose row bound a template. */
export interface ResolvedRender {
  front: string;
  frontType: TemplateFaceType;
  back: string;
  backType: TemplateFaceType;
  notes?: string;
  notesType?: TemplateFaceType;
}

/** Normalize a tag for comparison: drop a leading '#' and lowercase. */
function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").toLowerCase();
}

/** Number of tags shared between a template and a set of card/file tags. */
function matchCount(template: DeckTemplate, cardTags: Set<string>): number {
  let count = 0;
  for (const tag of template.tags) {
    if (cardTags.has(normalizeTag(tag))) count++;
  }
  return count;
}

/**
 * Pick the best template for a tag set: the one sharing the most tags, breaking
 * ties alphabetically by source_file. Returns null when nothing matches.
 */
function bestMatch(
  templates: DeckTemplate[],
  tags: string[]
): DeckTemplate | null {
  if (tags.length === 0) return null;
  const cardTags = new Set(tags.map(normalizeTag));
  let best: DeckTemplate | null = null;
  let bestScore = 0;
  for (const template of templates) {
    const score = matchCount(template, cardTags);
    if (score === 0) continue;
    if (
      score > bestScore ||
      (score === bestScore &&
        best !== null &&
        template.sourceFile < best.sourceFile)
    ) {
      best = template;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Resolve and merge the template bound to a flashcard's row.
 *  Tier 1: a tag on the header(s) containing the table (the card's `tags`)
 *          matches a template.
 *  Tier 2: a tag in the note's frontmatter (file_tags) matches a template.
 *  Tier 3: no match → null (caller renders the default columns).
 */
export function resolveCardTemplate(
  headerTags: string[],
  fileTags: string[],
  row: TemplateRow | null | undefined,
  templates: DeckTemplate[]
): ResolvedRender | null {
  if (!row || templates.length === 0) return null;

  const template =
    bestMatch(templates, headerTags) ?? bestMatch(templates, fileTags);
  if (!template) return null;

  const merged: ResolvedRender = {
    front: mergeTemplate(template.frontTemplate, row.cells, row.headers),
    frontType: template.frontType,
    back: mergeTemplate(template.backTemplate, row.cells, row.headers),
    backType: template.backType,
  };
  if (template.notesTemplate) {
    merged.notes = mergeTemplate(template.notesTemplate, row.cells, row.headers);
    merged.notesType = template.notesType ?? "md";
  }
  return merged;
}
