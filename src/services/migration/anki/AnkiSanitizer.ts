/**
 * Converts an Anki field value (HTML, with Anki-specific markup) into clean
 * Decks markdown. Pure string transforms — no DOM, so it runs in core.
 *
 * Handles: cloze deletions, `[sound:…]`, `<img>`, MathJax delimiters, common
 * block/inline HTML, and HTML entities. Media filenames encountered along the
 * way are collected so the caller knows which files to copy into the vault.
 */

const SOUND_TAG = /\[sound:([^\]]+)\]/g;
const IMG_TAG = /<img\b[^>]*?\bsrc\s*=\s*["']?([^"'>\s]+)["']?[^>]*>/gi;
// {{c1::answer}} or {{c1::answer::hint}} — the cloze number is ignored; Decks
// derives card order from document position of each ==highlight==.
const CLOZE_TAG = /\{\{c\d+::((?:(?!::|\}\}).)*)(?:::((?:(?!\}\}).)*))?\}\}/g;
const MATHJAX_INLINE = /\\\(([\s\S]*?)\\\)/g;
const MATHJAX_BLOCK = /\\\[([\s\S]*?)\\\]/g;

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export interface SanitizeResult {
  text: string;
  media: string[];
}

export class AnkiSanitizer {
  /**
   * Sanitize a single Anki field value to Decks markdown.
   *
   * @param hintLabel label prefixed to a relocated cloze hint (default "hint").
   */
  static sanitizeField(value: string, hintLabel = "hint"): SanitizeResult {
    const media: string[] = [];
    if (!value) return { text: "", media };

    let text = value;

    // [sound:file.mp3] → ![[file.mp3]]
    text = text.replace(SOUND_TAG, (_match, file: string) => {
      const name = file.trim();
      if (name) media.push(name);
      return `![[${name}]]`;
    });

    // <img src="file.jpg"> → ![[file.jpg]]
    text = text.replace(IMG_TAG, (_match, src: string) => {
      const name = decodeURIComponent(src.trim());
      if (name) media.push(name);
      return `![[${name}]]`;
    });

    // {{c1::answer::hint}} → ==answer== (hint: hint)
    text = text.replace(CLOZE_TAG, (_match, answer: string, hint?: string) => {
      const inner = answer.trim();
      const suffix = hint && hint.trim() ? ` (${hintLabel}: ${hint.trim()})` : "";
      return `==${inner}==${suffix}`;
    });

    // MathJax \( … \) → $ … $   and   \[ … \] → $$ … $$
    text = text.replace(MATHJAX_BLOCK, (_m, body: string) => `$$${body.trim()}$$`);
    text = text.replace(MATHJAX_INLINE, (_m, body: string) => `$${body.trim()}$`);

    text = AnkiSanitizer.stripHtml(text);
    text = AnkiSanitizer.decodeEntities(text);

    return { text: AnkiSanitizer.collapseWhitespace(text), media };
  }

  // Convert structural HTML to newlines and drop everything else, leaving the
  // text content. Block elements become line breaks; inline tags are removed.
  private static stripHtml(input: string): string {
    let text = input;
    // Drop <style>/<script> blocks entirely (Anki templates carry heavy CSS).
    text = text.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "");
    // Block-level boundaries → newline.
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(div|p|h[1-6]|li|tr)>/gi, "\n");
    text = text.replace(/<(div|p|h[1-6]|li|tr|ul|ol|table|tbody)\b[^>]*>/gi, "\n");
    // Any remaining tag → removed.
    text = text.replace(/<[^>]+>/g, "");
    return text;
  }

  private static decodeEntities(input: string): string {
    // Stray entities not in the map are left as-is.
    return input.replace(/&[a-zA-Z]+;|&#\d+;/g, (entity) => {
      if (entity in HTML_ENTITIES) return HTML_ENTITIES[entity];
      const numeric = /^&#(\d+);$/.exec(entity);
      if (numeric) return String.fromCodePoint(Number(numeric[1]));
      return entity;
    });
  }

  // Trim, drop trailing spaces per line, and collapse 3+ blank lines to one.
  private static collapseWhitespace(input: string): string {
    return input
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, (m) => (m.length ? "" : m)))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
