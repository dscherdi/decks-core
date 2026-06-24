/**
 * Type definitions for the 1-to-Many table template engine.
 *
 * A template maps a markdown table row to a custom card side (front / back /
 * notes) rendered either as Markdown or as sanitized HTML. Templates are
 * authored as files in a folder, cached in the deck_templates table, and bound
 * to flashcards by tag at render time.
 */

export type TemplateEngine = "md" | "html";

export type TemplateSide = "front" | "back" | "notes";

export interface TemplateField {
  engine: TemplateEngine;
  template: string;
}

/**
 * The templates chosen for a file after the cascade. Any side may be absent;
 * a set with no `front` is not usable for building template cards.
 */
export interface ResolvedTemplateSet {
  front?: TemplateField;
  back?: TemplateField;
  notes?: TemplateField;
}
