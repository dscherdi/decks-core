import { AnkiSanitizer } from "./AnkiSanitizer";
import type { AnkiModel, AnkiTemplate } from "./AnkiTypes";

/**
 * Builds a Decks `decks-html` template file from an Anki model's card template
 * (`qfmt`/`afmt`). The Anki `{{Field}}` syntax maps directly onto Decks'
 * template variables, so the HTML is kept almost verbatim — conditionals are
 * flattened (Decks `mergeTemplate` has no `{{#}}/{{^}}`), `{{FrontSide}}` and
 * field modifiers are normalized, `<script>` is dropped, and static media is
 * rewritten to `![[…]]` so the HTML render resolves it. Pure strings — no DOM.
 */

export interface AnkiTemplateFile {
  tag: string; // binding tag (no leading #), e.g. "anki-tpl/basic-0"
  relativePath: string; // file path within the template folder (no folder prefix)
  content: string; // full markdown file content
}

const HR_ANSWER = /<hr\s+id\s*=\s*["']?answer["']?\s*\/?>/i;
const SCRIPT = /<script\b[\s\S]*?<\/script>/gi;
const FRONTSIDE = /\{\{\s*FrontSide\s*\}\}/g;
// {{modifier:Field}} (text:/hint:/type:/furigana:/…) → {{Field}}
const MODIFIER = /\{\{\s*[a-zA-Z]+:([^}]+)\}\}/g;

export class AnkiTemplateExporter {
  /** Binding tag for a model template (no leading #). */
  static tagFor(model: AnkiModel, ord: number): string {
    return `anki-tpl/${slug(model.name) || model.id}-${ord}`;
  }

  /** Binding tag for a cloze model's template (no leading #). */
  static clozeTagFor(model: AnkiModel): string {
    return `anki-tpl-cloze/${slug(model.name) || model.id}`;
  }

  /**
   * Build a **markdown** template for a cloze model: the front face is the cloze
   * field (ignored at cloze-render time, which blanks the raw cell), and the
   * notes face shows the extra fields (surfaced via the answer-side Notes button).
   */
  static buildCloze(model: AnkiModel, clozeField: string, extraFields: string[]): AnkiTemplateFile {
    const tag = AnkiTemplateExporter.clozeTagFor(model);
    const notes = extraFields.map((name) => `{{${name}}}`).join("\n\n");
    const content =
      `---\ntags:\n  - ${tag}\n---\n\n` +
      "```decks-md-front\n" +
      `{{${clozeField}}}\n` +
      "```\n\n" +
      "```decks-md-notes\n" +
      `${notes}\n` +
      "```\n";
    return { tag, relativePath: `${slug(model.name) || model.id}-cloze.md`, content };
  }

  /**
   * A model carries a deliberate CSS layout (grid/flex/positioned/etc.) that only
   * the HTML render can reproduce — such models keep an `decks-html` template;
   * everything else uses a `decks-md` template so card data renders as markdown.
   */
  static hasRichCss(css: string | undefined): boolean {
    if (!css) return false;
    // Only genuine page-layout signals — not size, and not `display:flex` /
    // `position:relative` (commonly just centering), which would misclassify
    // ordinary text cards (their data must stay markdown).
    return /grid-template|display\s*:\s*(grid|inline-grid)|float\s*:\s*(left|right)|position\s*:\s*(absolute|fixed)|@media|column-count|columns\s*:/i.test(
      css
    );
  }

  static build(model: AnkiModel, tmpl: AnkiTemplate): AnkiTemplateFile {
    const tag = AnkiTemplateExporter.tagFor(model, ord(tmpl));
    const front = AnkiTemplateExporter.prepare(tmpl.qfmt, model.css);
    const back = AnkiTemplateExporter.prepare(AnkiTemplateExporter.answerSide(tmpl.afmt), model.css);

    const fence = "`".repeat(Math.max(3, longestBacktickRun(front + back) + 1));
    const content =
      `---\ntags:\n  - ${tag}\n---\n\n` +
      `${fence}decks-html-front\n${front}\n${fence}\n\n` +
      `${fence}decks-html-back\n${back}\n${fence}\n`;

    return { tag, relativePath: `${slug(model.name) || model.id}-${ord(tmpl)}.md`, content };
  }

  // afmt is FrontSide + <hr id=answer> + answer; keep only the answer side.
  private static answerSide(afmt: string): string {
    const match = HR_ANSWER.exec(afmt);
    return match ? afmt.slice(match.index + match[0].length) : afmt;
  }

  // Keep the Anki HTML almost verbatim: Mustache sections stay (Decks'
  // mergeTemplate evaluates them now), {{FrontSide}}/modifiers are normalized,
  // `<script>` is dropped, static media → ![[…]]. The model stylesheet is
  // injected as a `<style>` block and the body wrapped in `.card` (Anki scopes
  // its rules there) so the card's CSS layout renders in Decks' shadow DOM.
  private static prepare(html: string, css: string | undefined): string {
    let out = html.replace(SCRIPT, "");
    out = out.replace(FRONTSIDE, "");
    out = out.replace(MODIFIER, (_m, field: string) => `{{${field.trim()}}}`);
    out = AnkiSanitizer.sanitizeField(out, { keepHtml: true }).text.trim();

    const style = css && css.trim() ? `<style>\n${css.trim()}\n</style>\n` : "";
    return `${style}<div class="card">\n${out}\n</div>`;
  }
}

function ord(tmpl: AnkiTemplate): number {
  return typeof tmpl.ord === "number" ? tmpl.ord : 0;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function longestBacktickRun(text: string): number {
  let max = 0;
  const matches = text.match(/`+/g);
  if (matches) for (const m of matches) max = Math.max(max, m.length);
  return max;
}
