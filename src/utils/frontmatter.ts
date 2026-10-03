// A note's frontmatter read the way Obsidian's metadata cache reads it, for surfaces
// without that cache: the same fence rule and the same YAML parser.
import { parse } from "yaml";

/**
 * The YAML between the fences, or null when the note has none: "---" opens on the
 * first line and the first later line starting with "---" closes it.
 */
function frontmatterBody(content: string): string | null {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return null;
  let close = text.indexOf("---", 3);
  while (close !== -1 && text[close - 1] !== "\n") close = text.indexOf("---", close + 3);
  return close === -1 ? null : text.slice(4, close - 1);
}

/** Whether the note asks for reverse cards: `reverse: true` as a YAML boolean, as the plugin reads it. */
export function wantsReverseCards(content: string): boolean {
  const body = frontmatterBody(content);
  if (body === null) return false;
  try {
    // Errors throw and an unknown tag only warns, as in Obsidian; "silent" would swallow errors.
    const parsed: unknown = parse(body, { logLevel: "error" });
    // Like Obsidian, frontmatter that isn't a mapping counts as none.
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "reverse" in parsed &&
      parsed.reverse === true
    );
  } catch {
    // Invalid YAML (a duplicate key, say) leaves Obsidian with no frontmatter at all.
    return false;
  }
}
