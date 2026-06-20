import { FlashcardParser } from "../FlashcardParser";
import { generateContentHash } from "../../utils/hash";
import { escapeTableCell } from "../../utils/markdown-table";

/**
 * Translated scheduling state for a single review direction.
 */
export interface FsrsState {
  due: number; // unix ms
  stability: number; // days
  difficulty: number; // 1-10
  reps: number;
  lapses: number;
  intervalDays: number; // SR scheduling interval; used to backdate the last review (due − interval)
}

export interface ClozeEntry {
  clozeText: string; // inner text of the ==highlight== (no hint)
  clozeOrder: number; // 0-based document order
  fsrsData?: FsrsState; // this cloze's migrated state; undefined => stays new
}

export interface MigratedCard {
  front: string; // clean front (no inline tags)
  back: string;
  tags: string[]; // translated to the target base tag
  isReverse: boolean;
  multiline: boolean; // ? / ?? cards (vs single-line :: / :::) — drives smart routing
  suspended: boolean; // legacy skip marker (#sr-skip or skip comment) → suspend on import
  fsrsData?: FsrsState; // forward direction; undefined => stays new
  fsrsDataReverse?: FsrsState; // reverse direction only
  clozes?: ClozeEntry[]; // when present, a cloze block (fsrsData/isReverse unused)
  blockId?: string; // header cards: block-ref anchor (delete mode)
  headerAnchor?: string; // table cards: container-header link target (delete mode); "" => link to file
  sourceMatch: string; // exact original text of the card block (for link replacement)
}

/**
 * Output routing for inline cards: "smart" sends single-line cards to tables and
 * multi-line cards to headers; "headers"/"tables" force one shape for all cards.
 */
export type MigrationFormat = "smart" | "headers" | "tables";

export interface ProcessOptions {
  srBaseTag: string; // e.g. "#flashcards"
  decksBaseTag: string; // e.g. "#decks"
  inlineSep?: string; // single-line separator (default "::"); reversed = sep + last char
  multiSep?: string; // multi-line separator (default "?"); reversed = sep + last char
  noteTitle?: string; // fallback front for a bare cloze block (no breadcrumb)
  hintLabel?: string; // translated label for relocated cloze hints (default "hint")
  clozeSep?: string; // SR cloze number/answer/hint separator (default ";;"); `::` always also accepted
}

export interface RenderOptions {
  withBlockRefs?: boolean;
  format?: MigrationFormat;
  noteTitle?: string;
  // The single deck tag for the output file's frontmatter (already translated,
  // no leading `#`, e.g. `decks/cleancode/comments`). Defaults to the base tag.
  // Decks parses exactly one deck tag per file, so this replaces — not augments
  // — the base tag.
  deckTag?: string;
}

export interface ProcessResult {
  cleanContent: string;
  dbRecords: MigratedCard[];
}

export interface RenderedFile {
  suffix: string; // "" for the main file, " (reversed)" for the reverse file
  reverse: boolean;
  content: string;
  cards: MigratedCard[];
}

interface SchedSegment {
  kind: "sched";
  date: string;
  interval: number;
  ease: number;
}
interface FsrsSegment {
  kind: "fsrs";
  difficulty: number;
  stability: number;
  reps: number;
  lapses: number;
}
type SrSegment = SchedSegment | FsrsSegment;

const SR_COMMENT = /<!--\s*SR:(.*?)-->/;
const SR_COMMENT_G = /<!--\s*SR:.*?-->/g;
const SR_YAML_KEY = /^\s*sr-[\w-]+\s*:/i;
const CALLOUT_HEADER = /^\s*>\s*\[!sr(\|[^\]]*)?\]/i;
const HEADER_LINE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[*+-]|\d+\.)\s+(.*)$/;
const LIST_MARKER = /^\s*(?:#{1,6}\s+|[*+-]\s+|\d+\.\s+)/;
// A fenced code-block delimiter (``` or ~~~, optionally indented / with a language).
const CODE_FENCE = /^\s*(?:```|~~~)/;
// Inert spans for `::`/`?` separator detection: inline code, $…$/$$…$$ math, and
// ==highlights==. Blanked to equal-length spaces so a separator inside them is
// never chosen, while indices still map back to the original text.
const INERT_SPAN_G = /`[^`]*`|\$\$[^$]*\$\$|\$[^$\n]+\$|==(?:(?!==).)+==/g;
function maskInertSpans(text: string): string {
  return text.replace(INERT_SPAN_G, (m) => " ".repeat(m.length));
}
// Trailing Obsidian block reference (e.g. ` ^abc-123`). Distinct from footnote
// hints `^[...]` (which have a bracket) so those are unaffected.
const BLOCK_REF = /\s*\^[A-Za-z0-9-]+\s*$/;

// Legacy "skip" markers — a card carrying any of these migrates as suspended.
const SKIP_TAG = /(?:^|\s)#sr-skip\b/i;
const SKIP_COMMENT_G = /<!--\s*sr-skip\s*-->|%%\s*sr-skip\s*%%/gi;
const DEFAULT_INLINE_SEP = "::";
const DEFAULT_MULTI_SEP = "?";

// Safely inject a user-supplied separator into a RegExp (custom separators can
// contain regex control characters).
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSkipMarked(text: string): boolean {
  return SKIP_TAG.test(text) || /<!--\s*sr-skip\s*-->|%%\s*sr-skip\s*%%/i.test(text);
}

const CURLY_CLOZE_G = /\{\{(.*?)\}\}/g;
const HIGHLIGHT_CLOZE = /==(?:(?!==).)+==/;
const HIGHLIGHT_CLOZE_G = /==((?:(?!==).)+)==/g;
const FOOTNOTE_HINT_G = /(==(?:(?!==).)+==)\s*\^\[([^\]]*)\]/g;

function hasCurlyCloze(text: string): boolean {
  return /\{\{.*?\}\}/.test(text);
}

function hasClozeMarkers(text: string): boolean {
  return hasCurlyCloze(text) || HIGHLIGHT_CLOZE.test(text);
}

const DEFAULT_CLOZE_SEP = ";;";

// Parse a cloze's inner text — `[number<sep>]answer[<sep>hint]` — and emit a
// Decks `==answer==` with the hint relocated outside (Decks has no native cloze
// hint). `<sep>` matches the configured separator OR `::`; a leading Anki `c\d+`
// or bare-number token is dropped.
function formatCloze(inner: string, sepRegex: RegExp, hintLabel: string): string {
  let parts = inner.split(sepRegex).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return `==${inner.trim()}==`;
  // Drop a leading Anki/legacy flag token: a cloze number (`c1`/`12`) or the
  // unsupported hide flag `h` (Decks shows/hides clozes via a profile setting,
  // not per-cloze). So `{{h::mass}}` → `==mass==`, `{{c1::x}}` → `==x==`.
  if (parts.length > 1 && /^(?:c?\d+|h)$/i.test(parts[0])) parts = parts.slice(1);
  const answer = parts[0] ?? "";
  const hint = parts.slice(1).join(" ").trim();
  return hint ? `==${answer}== (${hintLabel}: ${hint})` : `==${answer}==`;
}

// Convert every legacy cloze form to Decks' native `==highlight==`, relocating
// hints to visible text after the highlight.
//   {{c1::x}} / {{x}} / ==1;;x==      -> ==x==
//   {{c1::x::hint}} / ==x;;hint==     -> ==x== (hint: hint)
//   ==x==^[hint]                      -> ==x== (hint: hint)
function convertClozeSyntax(text: string, hintLabel: string, clozeSep: string): string {
  const sep = clozeSep || DEFAULT_CLOZE_SEP;
  const sepRegex = new RegExp(`\\s*(?:${escapeRegExp(sep)}|::)\\s*`);
  return text
    .replace(CURLY_CLOZE_G, (_m, raw: string) => formatCloze(raw, sepRegex, hintLabel))
    .replace(HIGHLIGHT_CLOZE_G, (_m, inner: string) => formatCloze(inner, sepRegex, hintLabel))
    .replace(FOOTNOTE_HINT_G, (_m, highlight: string, hint: string) =>
      hint.trim() ? `${highlight} (${hintLabel}: ${hint.trim()})` : highlight
    );
}

// The highlights of an already-converted block, in document order.
function extractClozes(converted: string): Array<{ clozeText: string; clozeOrder: number }> {
  const result: Array<{ clozeText: string; clozeOrder: number }> = [];
  let match: RegExpExecArray | null;
  HIGHLIGHT_CLOZE_G.lastIndex = 0;
  while ((match = HIGHLIGHT_CLOZE_G.exec(converted)) !== null) {
    result.push({ clozeText: match[1].trim(), clozeOrder: result.length });
  }
  return result;
}

// Strip a leading markdown header/list marker (`## `, `* `, `1. `) so the front
// and breadcrumb labels carry text only.
function stripMarkers(text: string): string {
  return text.replace(LIST_MARKER, "").trim();
}

function clampDifficulty(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, value));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Strip trailing/inline `#tags` from card body text WITHOUT collapsing newlines
// (multi-line backs keep their code blocks, lists, and paragraphs). Tags are
// matched only when preceded by a space/tab or start-of-line.
const BODY_TAG_REGEX = /(?:^|[ \t])#([A-Za-z][A-Za-z0-9_/-]*)/gm;
function extractBodyTags(text: string): { cleaned: string; tags: string[] } {
  const tags: string[] = [];
  const cleaned = text
    .replace(BODY_TAG_REGEX, (_m, tag: string) => {
      tags.push(tag);
      return "";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n/g, "\n")
    .trim();
  const unique = Array.from(new Set(tags.map((t) => t.toLowerCase())));
  return { cleaned, tags: unique };
}

// A short, stable 6-char block-reference id (e.g. ^a1b2c3). Derived from the
// card front + ordinal so duplicate fronts stay distinct. Block refs are immune
// to Obsidian's heading-link sanitization (punctuation, `?`, `+`).
function shortBlockId(seed: string): string {
  return (generateContentHash(seed) + "000000").slice(0, 6);
}

// A heading label safe to use as a wiki link target: strips characters that
// break Obsidian heading links (`#`, `|`, `[`, `]`, `^`, punctuation), keeping
// letters/numbers/spaces/dashes. `index` disambiguates groups within a file.
function safeHeaderLabel(noteTitle: string | undefined, index: number): string {
  const base =
    (noteTitle ?? "").replace(/[^\p{L}\p{N} -]/gu, "").replace(/\s+/g, " ").trim() || "Cards";
  return index === 0 ? base : `${base} ${index + 1}`;
}

// Readable label for the tag-carrier parent header of a delete-mode table.
function parentTagLabel(tags: string[]): string {
  const seg = tags[0]?.split("/").pop() ?? "";
  return seg.replace(/[^\p{L}\p{N} -]/gu, "").trim() || "Tags";
}

/**
 * LegacySrMigrator — converts notes written for the incumbent "Spaced
 * Repetition" plugin into the structural header/paragraph format, translating
 * the legacy SM-2/FSRS scheduling state for each review direction.
 */
export class LegacySrMigrator {
  static processFile(content: string, opts: ProcessOptions): ProcessResult {
    const lines = content.split(/\r?\n/);
    const cards: MigratedCard[] = [];
    const headerStack: { level: number; text: string }[] = [];
    const listStack: { indent: number; text: string }[] = [];
    let pendingLines: string[] = [];
    let pendingStart = 0;
    let inCodeBlock = false;

    const start = LegacySrMigrator.frontmatterEnd(lines);
    const loneTitleIdx = LegacySrMigrator.loneTitleH1Index(lines, start);
    const breadcrumb = (): string[] => [
      ...headerStack.map((h) => h.text),
      ...listStack.map((l) => l.text),
    ];

    // Dynamic separators — the reversed variant repeats the last char (`::`→`:::`,
    // `?`→`??`), matching the legacy plugin. Custom separators may contain regex
    // metacharacters, so the inline matcher is compiled per call with escaping.
    const inlineSep = opts.inlineSep || DEFAULT_INLINE_SEP;
    const multiSep = opts.multiSep || DEFAULT_MULTI_SEP;
    const inlineRev = inlineSep + inlineSep.slice(-1);
    const multiRev = multiSep + multiSep.slice(-1);
    // Groups: 1=front, 2=whitespace before the separator, 3=reverse sep,
    // 4=forward sep, 5=back. Group 2 lets us map the separator's index from the
    // masked copy back onto the original text.
    const inlineRegex = new RegExp(
      `^(.*?)(\\s*)(?:(${escapeRegExp(inlineRev)})|(${escapeRegExp(inlineSep)}))\\s*(.+)$`
    );
    const detectInline = (
      text: string
    ): { front: string; back: string; isReverse: boolean } | null => {
      // Locate the separator on a copy with inert spans (code/math/highlights)
      // blanked, then split the ORIGINAL at that index so a `::`/`?` inside code,
      // math, or a highlight is never treated as the separator.
      const m = inlineRegex.exec(maskInertSpans(text));
      if (!m) return null;
      const sep = m[3] ?? m[4];
      const sepStart = m[1].length + m[2].length;
      const front = text.slice(0, sepStart).trim();
      const back = text.slice(sepStart + sep.length).trim();
      if (!back) return null;
      return { front, back, isReverse: !!m[3] };
    };
    const isMultiSep = (t: string): boolean => t === multiRev || t === multiSep;

    // A buffered paragraph that contains cloze markers becomes a cloze card.
    const flushPending = (): void => {
      if (pendingLines.length === 0) return;
      const block = pendingLines.join("\n");
      pendingLines = [];
      if (!hasClozeMarkers(block)) return; // orphan prose
      const card = LegacySrMigrator.buildClozeCard(block, block, breadcrumb(), opts);
      if (card) cards.push(card);
    };

    let i = start;
    while (i < lines.length) {
      const rawLine = lines[i];

      // Fenced code blocks are inert: toggle on the fence delimiter and skip
      // every line inside so `::`/`?`/`==`/`{{}}` in code never produce cards.
      if (CODE_FENCE.test(rawLine)) {
        inCodeBlock = !inCodeBlock;
        i++;
        continue;
      }
      if (inCodeBlock) {
        i++;
        continue;
      }

      const trimmed = rawLine.trim();

      if (trimmed === "") {
        // A blank inside a buffered cloze block is internal when the next
        // non-blank line continues it (another cloze line / SR comment / callout,
        // but not a list item or header) — keep buffering so one trailing comment
        // binds the whole multi-paragraph block.
        if (pendingLines.length > 0 && hasClozeMarkers(pendingLines.join("\n"))) {
          let k = i + 1;
          while (k < lines.length && lines[k].trim() === "") k++;
          const next = k < lines.length ? lines[k] : null;
          const continues =
            next !== null &&
            !HEADER_LINE.test(next) &&
            !LIST_ITEM.test(next) &&
            (hasClozeMarkers(next) ||
              LegacySrMigrator.getSrInner(next) !== null ||
              CALLOUT_HEADER.test(next));
          if (continues) {
            pendingLines.push(rawLine);
            i++;
            continue;
          }
        }
        flushPending();
        listStack.length = 0;
        i++;
        continue;
      }

      // Decoration / metadata-only lines: part of a buffered (cloze) block when
      // one is open, else attach to the most recent card.
      const inner = LegacySrMigrator.getSrInner(rawLine);
      if (CALLOUT_HEADER.test(rawLine)) {
        if (pendingLines.length > 0) pendingLines.push(rawLine);
        else {
          const last = cards[cards.length - 1];
          if (last) last.sourceMatch += "\n" + rawLine;
        }
        i++;
        continue;
      }
      if (inner !== null) {
        const remainder = rawLine.replace(SR_COMMENT_G, "").replace(/^\s*>\s?/, "").trim();
        if (remainder === "") {
          if (pendingLines.length > 0) {
            pendingLines.push(rawLine);
          } else {
            const last = cards[cards.length - 1];
            if (last) {
              last.sourceMatch += "\n" + rawLine;
              if (!last.fsrsData) LegacySrMigrator.applyStates(last, LegacySrMigrator.statesFromInner(inner));
            }
          }
          i++;
          continue;
        }
      }

      // Header → update the breadcrumb stack (skip the lone note-title H1).
      const headerMatch = HEADER_LINE.exec(rawLine);
      if (headerMatch) {
        flushPending();
        listStack.length = 0;
        if (i !== loneTitleIdx) {
          const level = headerMatch[1].length;
          while (headerStack.length && headerStack[headerStack.length - 1].level >= level) {
            headerStack.pop();
          }
          headerStack.push({ level, text: LegacySrMigrator.cleanLabel(headerMatch[2]) });
        }
        i++;
        continue;
      }

      // List item → context bullet, list-nested Q/A card, or list-nested cloze.
      const listMatch = LIST_ITEM.exec(rawLine);
      if (listMatch) {
        flushPending();
        const indent = listMatch[1].replace(/\t/g, "    ").length;
        while (listStack.length && listStack[listStack.length - 1].indent >= indent) {
          listStack.pop();
        }
        const content2 = listMatch[2].replace(SR_COMMENT_G, "").trim();
        // Cloze precedence: curly is unambiguous; `==` is a cloze unless a `::`
        // separator sits OUTSIDE the highlights (then it's a Q/A list card).
        // detectInline masks highlights internally, so a `::` inside `==…==`
        // doesn't count as a separator.
        const itemIsQa = detectInline(content2) !== null;
        if (hasCurlyCloze(listMatch[2]) || (HIGHLIGHT_CLOZE.test(listMatch[2]) && !itemIsQa)) {
          // Sibling/loose list items under the same bullet, their internal blank
          // separators, and the trailing SR comment form ONE cloze block — SR
          // binds the comment's N states to the whole preceding block.
          const asm = LegacySrMigrator.assembleClozeBlock(lines, i);
          const card = LegacySrMigrator.buildClozeCard(
            asm.block,
            asm.block,
            breadcrumb(),
            opts
          );
          if (card) cards.push(card);
          i = asm.endIdx;
          continue;
        }
        const detected = detectInline(content2);
        if (detected) {
          cards.push(
            LegacySrMigrator.buildCard(
              detected.front,
              detected.back,
              detected.isReverse,
              false,
              isSkipMarked(rawLine),
              LegacySrMigrator.statesFromInner(inner),
              rawLine,
              opts,
              breadcrumb()
            )
          );
          listStack.push({ indent, text: LegacySrMigrator.cleanLabel(detected.front) });
        } else {
          listStack.push({ indent, text: LegacySrMigrator.cleanLabel(content2) });
        }
        i++;
        continue;
      }

      // Multi-line separator → buffered lines are the front, following lines the back.
      if (isMultiSep(trimmed)) {
        // A buffered cloze block isn't a multi-line front — flush it and drop the stray separator.
        if (pendingLines.length > 0 && hasClozeMarkers(pendingLines.join("\n"))) {
          flushPending();
          i++;
          continue;
        }
        let front = pendingLines.join("\n").replace(SR_COMMENT_G, "").trim();
        const frontStart = pendingStart;
        pendingLines = [];
        // Outliner style: a list item directly followed by an indented `?`/`??`
        // uses that item as the front (it was buffered as a context bullet).
        // Pop it so it's the card front, not also a breadcrumb ancestor.
        if (!front && listStack.length > 0) {
          front = listStack.pop()?.text ?? "";
        }
        const backLines: string[] = [];
        let backInner: string | null = null;
        let j = i + 1;
        while (j < lines.length) {
          const bl = lines[j];
          // The multi-line back runs until a blank line / header / EOF. List
          // items ARE valid back content (e.g. a `?` card answered by a bulleted
          // list), so do NOT stop on them.
          if (bl.trim() === "" || HEADER_LINE.test(bl)) break;
          const bi = LegacySrMigrator.getSrInner(bl);
          if (bi !== null && backInner === null) backInner = bi;
          if (bi !== null || CALLOUT_HEADER.test(bl)) {
            const rem = bl.replace(SR_COMMENT_G, "").replace(/^\s*>\s?/, "").trim();
            if (rem === "") {
              j++;
              continue;
            }
          }
          backLines.push(bl.replace(SR_COMMENT_G, "").trimEnd());
          j++;
        }
        const back = backLines.join("\n").trim();
        if (front && back) {
          const block = lines.slice(frontStart, j).join("\n");
          cards.push(
            LegacySrMigrator.buildCard(
              front,
              back,
              trimmed === multiRev,
              true,
              isSkipMarked(block),
              LegacySrMigrator.statesFromInner(backInner),
              block,
              opts,
              breadcrumb()
            )
          );
        }
        i = j;
        continue;
      }

      // Single-line card? Curly cloze takes precedence over `::`. A `::` is a Q/A
      // separator only when it sits OUTSIDE a `==highlight==` (so `==a::b==` stays
      // a cloze); otherwise the line buffers as a cloze/prose block.
      const lineContent = rawLine.replace(SR_COMMENT_G, "").trim();
      const detected = hasCurlyCloze(lineContent)
        ? null
        : detectInline(lineContent);
      if (detected) {
        pendingLines = [];
        cards.push(
          LegacySrMigrator.buildCard(
            detected.front,
            detected.back,
            detected.isReverse,
            false,
            isSkipMarked(rawLine),
            LegacySrMigrator.statesFromInner(inner),
            rawLine,
            opts,
            breadcrumb()
          )
        );
        i++;
        continue;
      }

      // Plain prose — buffer as a potential multi-line front or cloze block
      // (kept raw so an inline SR comment survives for cloze state extraction).
      if (pendingLines.length === 0) pendingStart = i;
      pendingLines.push(rawLine.trimEnd());
      i++;
    }
    flushPending();

    return {
      cleanContent: LegacySrMigrator.stripMetadata(content),
      dbRecords: cards,
    };
  }

  /**
   * Derive the single deck tag for an output file from the note's SR tags.
   * Picks the most‑specific (deepest) SR base subtag and translates it to the
   * Decks base namespace (`flashcards/cleancode/comments` →
   * `decks/cleancode/comments`). Falls back to the bare Decks base when only the
   * base tag (or none) is present. Decks parses exactly one deck tag per file,
   * so the result is a single tag. `tags` are raw tag strings (a leading `#` is
   * tolerated).
   */
  static deriveDeckTag(
    tags: string[],
    opts: Pick<ProcessOptions, "srBaseTag" | "decksBaseTag">
  ): string {
    const decksBase = opts.decksBaseTag.replace(/^#/, "");
    const srBase = opts.srBaseTag.replace(/^#/, "").toLowerCase();
    if (!srBase) return decksBase;
    let best: string | null = null;
    let bestDepth = -1;
    for (const raw of tags) {
      const tag = raw.replace(/^#/, "");
      const lower = tag.toLowerCase();
      if (lower !== srBase && !lower.startsWith(srBase + "/")) continue;
      const translated =
        lower === srBase ? decksBase : decksBase + tag.slice(srBase.length);
      const depth = translated.split("/").length;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = translated;
      }
    }
    return best ?? decksBase;
  }

  /**
   * Derive the review deck tag: `decks/review` plus the path after the SR review
   * base (`review/spanish` → `decks/review/spanish`). `tags` are raw tag strings
   * (leading `#` tolerated). Falls back to `<decksBase>/review` when only the
   * bare review tag (or none) is present.
   */
  static deriveReviewTag(
    tags: string[],
    srReviewTag: string,
    decksBaseTag: string
  ): string {
    const decksBase = decksBaseTag.replace(/^#/, "");
    const reviewBase = srReviewTag.replace(/^#/, "").toLowerCase();
    const fallback = `${decksBase}/review`;
    if (!reviewBase) return fallback;
    let best: string | null = null;
    let bestDepth = -1;
    for (const raw of tags) {
      const tag = raw.replace(/^#/, "");
      const lower = tag.toLowerCase();
      if (lower !== reviewBase && !lower.startsWith(reviewBase + "/")) continue;
      // Map the SR review base → `<decksBase>/review`, preserving any subpath.
      const subPath = lower === reviewBase ? "" : tag.slice(reviewBase.length);
      const translated = `${decksBase}/review${subPath}`;
      const depth = translated.split("/").length;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = translated;
      }
    }
    return best ?? fallback;
  }

  private static frontmatterEnd(lines: string[]): number {
    if (lines[0]?.trim() !== "---") return 0;
    const end = lines.indexOf("---", 1);
    return end === -1 ? 0 : end + 1;
  }

  // A single leading H1 that is the document's first header is treated as the
  // note title and excluded from breadcrumbs. Multiple H1s are kept.
  private static loneTitleH1Index(lines: string[], start: number): number {
    let firstHeaderIdx = -1;
    let firstH1Idx = -1;
    let h1Count = 0;
    for (let i = start; i < lines.length; i++) {
      const m = HEADER_LINE.exec(lines[i]);
      if (!m) continue;
      if (firstHeaderIdx === -1) firstHeaderIdx = i;
      if (m[1].length === 1) {
        h1Count++;
        if (firstH1Idx === -1) firstH1Idx = i;
      }
    }
    return h1Count === 1 && firstH1Idx === firstHeaderIdx ? firstH1Idx : -1;
  }

  private static cleanLabel(text: string): string {
    return stripMarkers(FlashcardParser.extractAndStripTags(text).cleaned);
  }

  private static lastSrInner(text: string): string | null {
    const matches = text.match(SR_COMMENT_G);
    if (!matches || matches.length === 0) return null;
    return matches[matches.length - 1].match(SR_COMMENT)?.[1] ?? null;
  }

  // Assemble a whole cloze block starting at `startIdx`. SR binds a single
  // trailing `<!--SR:…-->` to the entire preceding block, which may span loose
  // (blank-separated) sibling list items / paragraphs. A blank line is internal
  // only when the next non-blank line continues the block (another cloze line, an
  // SR comment, or a callout). Any line carrying an SR comment is the binder and
  // ends the block; a header or EOF ends it (exclusive). Returns the end index
  // (exclusive) and the raw block text spanning it.
  private static assembleClozeBlock(
    lines: string[],
    startIdx: number
  ): { endIdx: number; block: string } {
    let i = startIdx;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        let k = i + 1;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k >= lines.length) break;
        const next = lines[k];
        const continues =
          !HEADER_LINE.test(next) &&
          (hasClozeMarkers(next) ||
            LegacySrMigrator.getSrInner(next) !== null ||
            CALLOUT_HEADER.test(next));
        if (!continues) break;
        i = k;
        continue;
      }
      if (HEADER_LINE.test(line)) break;
      const inner = LegacySrMigrator.getSrInner(line);
      i++;
      if (inner !== null) break; // the binder comment ends the block
    }
    return { endIdx: i, block: lines.slice(startIdx, i).join("\n") };
  }

  // Build a cloze MigratedCard from a block (paragraph or list-item content).
  // `contentText` holds the cloze body + its SR comment; `sourceMatch` is the
  // raw original for delete-mode replacement. Returns null if no cloze remains.
  private static buildClozeCard(
    contentText: string,
    sourceMatch: string,
    breadcrumb: string[],
    opts: ProcessOptions
  ): MigratedCard | null {
    const hintLabel = opts.hintLabel || "hint";
    const states = LegacySrMigrator.statesFromInnerAll(LegacySrMigrator.lastSrInner(contentText));
    const suspended = isSkipMarked(contentText);

    const cleaned = contentText
      .split(/\r?\n/)
      .filter((l) => !CALLOUT_HEADER.test(l))
      .map((l) =>
        l
          .replace(SR_COMMENT_G, "")
          .replace(BLOCK_REF, "")
          .replace(/^\s*(?:[*+-]|\d+[.)])\s+/, "")
      )
      .join("\n")
      .replace(SKIP_COMMENT_G, "")
      .trim();

    const backParsed = extractBodyTags(cleaned);
    const tags = LegacySrMigrator.translateTags(backParsed.tags, opts);
    const back = convertClozeSyntax(backParsed.cleaned, hintLabel, opts.clozeSep ?? DEFAULT_CLOZE_SEP).trim();
    const entries = extractClozes(back);
    if (entries.length === 0) return null;

    const front =
      breadcrumb.filter((p) => p.length > 0).join(" > ") || normalizeText(opts.noteTitle || "");

    return {
      front,
      back,
      tags,
      isReverse: false,
      multiline: true,
      suspended,
      clozes: entries.map((c) => ({ ...c, fsrsData: states[c.clozeOrder] })),
      sourceMatch,
    };
  }

  private static buildCard(
    rawFront: string,
    rawBack: string,
    isReverse: boolean,
    multiline: boolean,
    suspended: boolean,
    states: { forward?: FsrsState; reverse?: FsrsState },
    sourceMatch: string,
    opts: ProcessOptions,
    breadcrumb: string[] = []
  ): MigratedCard {
    // Strip skip comments + a trailing Obsidian block reference (the #sr-skip
    // tag is dropped in translateTags).
    const cleanFront = rawFront.replace(SKIP_COMMENT_G, "").replace(BLOCK_REF, "");
    const cleanBack = rawBack.replace(SKIP_COMMENT_G, "").replace(BLOCK_REF, "");
    const frontParsed = FlashcardParser.extractAndStripTags(cleanFront);
    const backParsed = extractBodyTags(cleanBack);
    const tags = LegacySrMigrator.translateTags(
      [...frontParsed.tags, ...backParsed.tags],
      opts
    );

    const ownFront = stripMarkers(normalizeText(frontParsed.cleaned));
    const front = [...breadcrumb, ownFront].filter((p) => p.length > 0).join(" > ");

    const card: MigratedCard = {
      front,
      back: backParsed.cleaned,
      tags,
      isReverse,
      multiline,
      suspended,
      sourceMatch,
    };
    LegacySrMigrator.applyStates(card, states);
    return card;
  }

  private static applyStates(
    card: MigratedCard,
    states: { forward?: FsrsState; reverse?: FsrsState }
  ): void {
    if (states.forward) card.fsrsData = states.forward;
    if (card.isReverse && states.reverse) card.fsrsDataReverse = states.reverse;
  }

  private static translateTags(tags: string[], opts: ProcessOptions): string[] {
    const srBase = opts.srBaseTag.replace(/^#/, "").toLowerCase();
    const decksBase = opts.decksBaseTag.replace(/^#/, "").toLowerCase();
    const result: string[] = [];
    for (const tag of tags) {
      if (tag === "sr-skip") continue; // control marker, not a real tag
      if (tag === srBase) continue; // base tag becomes the file-level deck tag
      if (tag === decksBase) continue;
      if (srBase && tag.startsWith(srBase + "/")) {
        result.push(decksBase + tag.slice(srBase.length));
      } else {
        result.push(tag);
      }
    }
    return Array.from(new Set(result));
  }

  private static getSrInner(line: string): string | null {
    const match = line.match(SR_COMMENT);
    return match ? match[1] : null;
  }

  private static statesFromInner(inner: string | null): {
    forward?: FsrsState;
    reverse?: FsrsState;
  } {
    const directions = LegacySrMigrator.statesFromInnerAll(inner);
    return { forward: directions[0], reverse: directions[1] };
  }

  // Every scheduling state packed in an SR comment, in order. Cloze blocks map
  // state[i] → the i-th highlight.
  private static statesFromInnerAll(inner: string | null): FsrsState[] {
    if (!inner) return [];
    const segments = LegacySrMigrator.classifySegments(inner);
    const directions: FsrsState[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.kind !== "sched") continue;
      let fsrs: FsrsSegment | null = null;
      const next = segments[i + 1];
      if (next && next.kind === "fsrs") {
        fsrs = next;
        i++;
      }
      const state = LegacySrMigrator.buildState(seg, fsrs);
      if (state) directions.push(state);
    }
    return directions;
  }

  private static classifySegments(inner: string): SrSegment[] {
    const rawSegments = inner
      .split("!")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const segments: SrSegment[] = [];
    for (const raw of rawSegments) {
      const parts = raw.split(",").map((p) => p.trim());
      if (parts.length === 3 && LegacySrMigrator.isDateLike(parts[0])) {
        segments.push({
          kind: "sched",
          date: parts[0],
          interval: Number(parts[1]),
          ease: Number(parts[2]),
        });
      } else if (parts.length === 4 && !LegacySrMigrator.isDateLike(parts[0])) {
        segments.push({
          kind: "fsrs",
          difficulty: Number(parts[0]),
          stability: Number(parts[1]),
          reps: Number(parts[2]),
          lapses: Number(parts[3]),
        });
      }
    }
    return segments;
  }

  private static isDateLike(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}/.test(value);
  }

  private static buildState(sched: SchedSegment, fsrs: FsrsSegment | null): FsrsState | null {
    const due = Date.parse(sched.date);
    if (!Number.isFinite(due)) return null;

    const interval = Number.isFinite(sched.interval) ? Math.max(sched.interval, 1) : 1;

    if (fsrs && Number.isFinite(fsrs.stability)) {
      return {
        due,
        stability: Math.max(fsrs.stability, 0),
        difficulty: clampDifficulty(fsrs.difficulty),
        reps: Number.isFinite(fsrs.reps) ? Math.max(fsrs.reps, 0) : 0,
        lapses: Number.isFinite(fsrs.lapses) ? Math.max(fsrs.lapses, 0) : 0,
        intervalDays: interval,
      };
    }

    const ease = sched.ease;
    const difficulty = ease > 250 ? 3 : ease < 210 ? 8 : 5;
    return { due, stability: interval, difficulty, reps: 1, lapses: 0, intervalDays: interval };
  }

  private static stripMetadata(content: string): string {
    const lines = content.split(/\r?\n/);
    const kept: string[] = [];
    for (const line of lines) {
      if (CALLOUT_HEADER.test(line)) continue;
      if (SR_YAML_KEY.test(line)) continue; // drop `sr-due:` etc. from frontmatter
      const hadComment = SR_COMMENT.test(line);
      const withoutComment = line.replace(SR_COMMENT_G, "");
      const remainder = withoutComment.replace(/^\s*>\s?/, "").trim();
      if (hadComment && remainder === "") continue;
      kept.push(withoutComment.replace(/\s+$/, ""));
    }
    return kept.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  private static stripFrontmatter(content: string): string {
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return content;
    const end = lines.indexOf("---", 1);
    if (end === -1) return content;
    return lines.slice(end + 1).join("\n");
  }

  /**
   * Parse the file-level scheduling state of an SR whole-note review: first from
   * `sr-*` YAML frontmatter keys (ISO 8601 dates only), else from the last
   * (unclaimed) `<!--SR:-->` comment in the body. Returns null when nothing
   * usable is found, so the note migrates as a brand-new card.
   */
  static parseFileLevelState(content: string): FsrsState | null {
    const yaml = LegacySrMigrator.parseSrFrontmatter(content);
    if (yaml) return yaml;

    // Fall back to the last SR comment in the file (the whole-note EOF marker).
    const matches = content.match(SR_COMMENT_G);
    if (matches && matches.length > 0) {
      const last = matches[matches.length - 1];
      const inner = last.match(SR_COMMENT)?.[1] ?? null;
      return LegacySrMigrator.statesFromInner(inner).forward ?? null;
    }
    return null;
  }

  private static parseSrFrontmatter(content: string): FsrsState | null {
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return null;
    const end = lines.indexOf("---", 1);
    if (end === -1) return null;

    const fm: Record<string, string> = {};
    for (let i = 1; i < end; i++) {
      const m = lines[i].match(/^\s*(sr-[\w-]+)\s*:\s*(.+?)\s*$/i);
      if (m) fm[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
    }

    const dueStr = fm["sr-due"];
    if (!dueStr) return null;
    // Obsidian frontmatter dates are ISO 8601 (YYYY-MM-DD); reject anything else
    // to avoid Date.parse locale ambiguity producing NaN / swapped month-day.
    if (!/^\d{4}-\d{2}-\d{2}/.test(dueStr)) return null;
    const due = Date.parse(dueStr);
    if (!Number.isFinite(due)) return null;

    const num = (key: string): number | undefined => {
      const raw = fm[key];
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };

    const interval = Math.max(num("sr-interval") ?? 1, 1);
    const stability = num("sr-stability");
    const difficulty = num("sr-difficulty");
    if (stability !== undefined || difficulty !== undefined) {
      return {
        due,
        stability: Math.max(stability ?? 1, 0),
        difficulty: clampDifficulty(difficulty ?? 5),
        reps: Math.max(num("sr-reps") ?? 1, 0),
        lapses: Math.max(num("sr-lapses") ?? 0, 0),
        intervalDays: interval,
      };
    }

    const ease = num("sr-ease") ?? 250;
    return {
      due,
      stability: interval,
      difficulty: ease > 250 ? 3 : ease < 210 ? 8 : 5,
      reps: 1,
      lapses: 0,
      intervalDays: interval,
    };
  }

  /**
   * Build a single migrated card from an SR whole-note review. In Decks title
   * mode the filename is the card front and the whole note body is the back.
   */
  static processWholeNote(content: string, title: string): MigratedCard {
    const body = LegacySrMigrator.stripMetadata(LegacySrMigrator.stripFrontmatter(content))
      .replace(SKIP_COMMENT_G, "")
      .trim();
    return {
      front: normalizeText(title),
      back: body,
      tags: [],
      isReverse: false,
      multiline: true,
      suspended: isSkipMarked(content),
      sourceMatch: content,
      fsrsData: LegacySrMigrator.parseFileLevelState(content) ?? undefined,
    };
  }

  /**
   * Render the migrated cards into one or two Decks files. Because reverse is a
   * file-level concern in Decks (a `reverse: true` frontmatter flag), reverse
   * cards are emitted into a separate file. `format` routes each card to a table
   * or a header block (see {@link MigrationFormat}); block refs force headers so
   * every card has a stable link anchor.
   */
  static renderDecksFiles(
    cards: MigratedCard[],
    decksBaseTag: string,
    headerLevel: number,
    options: RenderOptions = {}
  ): RenderedFile[] {
    const forward = cards.filter((c) => !c.isReverse);
    const reverse = cards.filter((c) => c.isReverse);
    const files: RenderedFile[] = [];
    if (forward.length) {
      files.push({
        suffix: "",
        reverse: false,
        content: LegacySrMigrator.renderFile(forward, decksBaseTag, headerLevel, false, options),
        cards: forward,
      });
    }
    if (reverse.length) {
      files.push({
        suffix: " (reversed)",
        reverse: true,
        content: LegacySrMigrator.renderFile(reverse, decksBaseTag, headerLevel, true, options),
        cards: reverse,
      });
    }
    return files;
  }

  private static renderFile(
    cards: MigratedCard[],
    decksBaseTag: string,
    headerLevel: number,
    reverse: boolean,
    options: RenderOptions
  ): string {
    // Exactly one deck tag per file (Decks parses a single deck tag). Defaults
    // to the base; the deepest SR subtag (e.g. decks/cleancode/comments) when
    // the caller derives one.
    const deckTag = (options.deckTag || decksBaseTag).replace(/^#/, "");
    const level = Math.min(6, Math.max(1, headerLevel || 2));
    const format: MigrationFormat = options.format ?? "smart";

    const frontmatterLines = ["---", "tags:", `  - ${deckTag}`];
    if (reverse) frontmatterLines.push("reverse: true");
    frontmatterLines.push("---", "");

    // Pipe guardrail: a `|` in a single-line card (LaTeX, matrices) would shatter
    // a table, and escaping it as `\|` breaks MathJax — so smart mode routes any
    // pipe-bearing card to a header instead.
    const asTable = (card: MigratedCard): boolean =>
      !card.clozes && // cloze blocks are always headers (highlights can't live in a table cell)
      (format === "tables" ||
        (format === "smart" &&
          !card.multiline &&
          !card.front.includes("|") &&
          !card.back.includes("|")));

    const tableCards = cards.filter(asTable);
    const headerCards = cards.filter((c) => !asTable(c));

    const sections: string[] = [];
    sections.push(
      ...LegacySrMigrator.renderTableSections(
        tableCards,
        level,
        options.noteTitle,
        options.withBlockRefs
      )
    );
    headerCards.forEach((card, ordinal) => {
      sections.push(LegacySrMigrator.renderHeaderBlock(card, level, ordinal, options.withBlockRefs));
    });

    return frontmatterLines.join("\n") + sections.join("\n\n") + "\n";
  }

  private static renderHeaderBlock(
    card: MigratedCard,
    level: number,
    ordinal: number,
    withBlockRefs?: boolean
  ): string {
    const hashes = "#".repeat(level);
    const tagSuffix = card.tags.map((t) => ` #${t}`).join("");
    let back = card.back.trim();
    if (withBlockRefs) {
      const blockId = shortBlockId(`${ordinal}:${card.front}`);
      card.blockId = blockId;
      back = `${back} ^${blockId}`;
    }
    return `${hashes} ${card.front}${tagSuffix}\n\n${back}`;
  }

  // Single-line cards become table rows. Tables can't carry per-row tags, so
  // group by tag-set and let an enclosing header supply the tags (the parser
  // assigns the header stack's tags to every row beneath it).
  //
  // In delete mode the original card is replaced with a link to the table's
  // container header — but tags in a heading break heading links, so the
  // linkable container header is kept clean and the tags move to a parent
  // header one level up.
  private static renderTableSections(
    cards: MigratedCard[],
    level: number,
    noteTitle?: string,
    withBlockRefs?: boolean
  ): string[] {
    if (cards.length === 0) return [];
    const hashes = "#".repeat(level);
    const groups = new Map<string, MigratedCard[]>();
    for (const card of cards) {
      const key = [...card.tags].sort().join(" ");
      const group = groups.get(key);
      if (group) group.push(card);
      else groups.set(key, [card]);
    }

    const sections: string[] = [];
    let index = 0;
    for (const group of groups.values()) {
      const tags = group[0].tags;
      const tagSuffix = tags.map((t) => ` #${t}`).join("");
      const table = `| Front | Back | Notes |\n| --- | --- | --- |\n${group
        .map((card) => `| ${escapeTableCell(card.front.trim())} | ${escapeTableCell(card.back.trim())} |  |`)
        .join("\n")}`;

      if (!withBlockRefs) {
        const label = noteTitle && noteTitle.trim().length > 0 ? noteTitle.trim() : "Cards";
        sections.push(`${hashes} ${label}${tagSuffix}\n\n${table}`);
      } else {
        const container = safeHeaderLabel(noteTitle, index);
        if (tags.length > 0 && level > 1) {
          // Parent header carries the tags; clean container header is the link target.
          const parent = "#".repeat(level - 1);
          group.forEach((c) => (c.headerAnchor = container));
          sections.push(`${parent} ${parentTagLabel(tags)}${tagSuffix}\n\n${hashes} ${container}\n\n${table}`);
        } else if (tags.length > 0) {
          // No room for a parent header (level 1) — keep tags inline, link to the file.
          group.forEach((c) => (c.headerAnchor = ""));
          sections.push(`${hashes} ${container}${tagSuffix}\n\n${table}`);
        } else {
          group.forEach((c) => (c.headerAnchor = container));
          sections.push(`${hashes} ${container}\n\n${table}`);
        }
      }
      index++;
    }
    return sections;
  }

  /**
   * Render a NEW title-mode review file from a whole-note review card. The
   * filename (set by the caller) is the card's front; the cleaned note body
   * (`card.back`, SR metadata already stripped by {@link processWholeNote}) is
   * the back. Frontmatter carries exactly the one `reviewTag` (e.g.
   * `decks/review`). The original note is never modified — this is a duplicate.
   */
  static renderTitleModeFile(card: MigratedCard, reviewTag: string): string {
    const tag = reviewTag.replace(/^#/, "");
    const body = card.back.trim();
    return `---\ntags:\n  - ${tag}\n---\n\n${body}\n`;
  }

  /**
   * Replace each migrated card in the original note with a link to its new home.
   * Header cards use a block-ref anchor (immune to heading-link sanitization and
   * duplicate fronts); table cards link to their container header (a row can't be
   * block-referenced). Requires the cards to have been rendered with block refs.
   */
  static buildLinkReplacedOriginal(
    originalContent: string,
    cards: MigratedCard[],
    mainBasename: string,
    reversedBasename: string
  ): string {
    let result = originalContent;
    for (const card of cards) {
      const basename = card.isReverse ? reversedBasename : mainBasename;
      let link: string | null = null;
      if (card.blockId) {
        link = `[[${basename}#^${card.blockId}]]`;
      } else if (card.headerAnchor) {
        link = `[[${basename}#${card.headerAnchor}]]`;
      } else if (card.headerAnchor === "") {
        link = `[[${basename}]]`;
      }
      if (link) result = result.replace(card.sourceMatch, link);
    }
    return result.replace(/\n{3,}/g, "\n\n");
  }
}
