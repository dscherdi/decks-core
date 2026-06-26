import type {
  ResolvedTemplateSet,
  TemplateEngine,
  TemplateSide,
} from "./types";

/**
 * Extracts and strips `decks-{html|md}-{front|back|notes}` fenced codeblocks.
 *
 * The fence info string selects the render engine (html/md) and the card side.
 * Used for Tier 1 (codeblocks in the deck file) and Tier 2 (codeblocks in a
 * frontmatter-referenced template file).
 */

const FENCE_OPEN = /^(`{3,}|~{3,})\s*([A-Za-z0-9-]*)\s*$/;
const LANG = /^decks-(html|md)-(front|back|notes)$/;

interface ParsedBlocks {
  set: ResolvedTemplateSet;
  /** Line indices (0-based) belonging to recognized template blocks, fences included. */
  consumed: Set<number>;
}

function parse(content: string): ParsedBlocks {
  const set: ResolvedTemplateSet = {};
  const consumed = new Set<number>();
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i].trim());
    if (!open) continue;
    const langMatch = LANG.exec(open[2]);
    if (!langMatch) continue;

    const fence = open[1];
    const engine = langMatch[1] as TemplateEngine;
    const side = langMatch[2] as TemplateSide;

    // Find the matching closing fence (same fence char, length >= open).
    const closeRe = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j].trim())) {
        end = j;
        break;
      }
    }
    if (end === -1) break; // unterminated block — leave the rest untouched

    const body = lines.slice(i + 1, end).join("\n");
    // First definition for a side wins (stable, deterministic).
    if (!set[side]) {
      set[side] = { engine, template: body };
    }
    for (let k = i; k <= end; k++) consumed.add(k);
    i = end;
  }

  return { set, consumed };
}

/** Extract the template set defined by recognized codeblocks in `content`. */
export function extractTemplateBlocks(content: string): ResolvedTemplateSet {
  return parse(content).set;
}

/**
 * Remove recognized template-definition codeblocks from `content` so they
 * never leak into parsed card bodies. Returns the content unchanged when no
 * template blocks are present.
 */
export function stripTemplateBlocks(content: string): string {
  const { consumed } = parse(content);
  if (consumed.size === 0) return content;
  const lines = content.split("\n");
  return lines.filter((_line, idx) => !consumed.has(idx)).join("\n");
}
