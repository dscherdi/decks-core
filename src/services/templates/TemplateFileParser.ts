import { extractTemplateBlocks } from "./CodeblockTemplateParser";
import type { ResolvedTemplateSet, TemplateField } from "./types";

/**
 * Parse a template markdown file's body into front/back/notes template fields.
 *
 * Strict fallback cascade:
 *  1. `decks-[html|md]-[front|back|notes]` codeblocks → per-side engine + body.
 *  2. Otherwise treat the file as pure markdown and split on the FIRST
 *     horizontal rule (`---` / `***` / `___` on its own line): everything above
 *     is the front (md), everything below is the back (md). No notes.
 *
 * Returns null when neither path yields a usable front. Tags (`decks-tags`)
 * are read from frontmatter by the caller (the plugin) — this stays pure.
 */

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const HORIZONTAL_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER, "");
}

export function parseTemplateFile(content: string): ResolvedTemplateSet | null {
  const blocks = extractTemplateBlocks(content);
  if (blocks.front || blocks.back || blocks.notes) return blocks;

  // Horizontal-rule fallback: split the body into front / back, both markdown.
  const body = stripFrontmatter(content);
  const lines = body.split("\n");
  const hrIndex = lines.findIndex((line) => HORIZONTAL_RULE.test(line));
  if (hrIndex === -1) return null;

  const front = lines.slice(0, hrIndex).join("\n").trim();
  const back = lines.slice(hrIndex + 1).join("\n").trim();
  if (!front) return null;

  const set: ResolvedTemplateSet = {
    front: { engine: "md", template: front } satisfies TemplateField,
  };
  if (back) set.back = { engine: "md", template: back };
  return set;
}
