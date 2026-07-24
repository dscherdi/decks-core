import { splitTableLine, unescapeTableCell } from "../utils/markdown-table";
import {
  clozeBindingKey,
  extractAnchorTokens,
  extractLineAnchors,
  headerBindingKey,
  isAnchorCommentBody,
  occlusionBindingKey,
  questionBindingKey,
  stripAnchorTokens,
  tableBindingKey,
  titleBindingKey,
  titleClozeBindingKey,
  type LineAnchor,
} from "../utils/anchors";
import type { TemplateRow } from "../database/types";
import { OcclusionV2Parser } from "./occlusion/OcclusionV2Parser";
import { classifyExamBody } from "./ExamClassifier";

export interface ParsedFlashcard {
  front: string;
  back: string;
  notes: string;
  type: "header-paragraph" | "table" | "cloze" | "image-occlusion" | "image-occlusion-v2" | "spatial" | "multiple-choice";
  breadcrumb: string;
  tags: string[];
  isReverse?: boolean;
  clozeText?: string;
  clozeOrder?: number;
  // Occlusion V2 only: stable mask id (identity for the card's FSRS history)
  // and the resolved image path, both folded into the card id.
  maskId?: string;
  imagePath?: string;
  // Canvas-only: id of the source text node this card came from. The canvas
  // extractor stamps it on each parsed card before the sync pipeline runs.
  sourceNodeId?: string;
  // Canvas spatial cards only: id of the edge that produced this card and the
  // edge label rendered as a hint on the front of the card.
  edgeId?: string;
  hint?: string;
  // Table rows carry their headers/cells/row-tags for render-time template binding.
  templateRow?: TemplateRow;
  // Anchor binding key derived from a dk token / frontmatter id / canvas id,
  // when the source carries one. Used for identity matching, never content.
  anchorKey?: string;
  // Cloze cards: index of this cloze within its own line (binding keys only;
  // clozeOrder stays body-scoped and feeds card ids).
  clozeLineIndex?: number;
}

/**
 * FlashcardParser - Consolidated parsing logic for flashcards from markdown content
 * Supports table-based, header-paragraph, and cloze flashcards with configurable header levels
 */
export class FlashcardParser {
  // Pre-compiled regex patterns for better performance
  private static readonly HEADER_REGEX = /^(#{1,6})\s+/;
  private static readonly TABLE_ROW_REGEX = /^\|.*\|$/;
  private static readonly TABLE_SEPARATOR_REGEX = /^\|[\s-]+\|[\s-]+\|(?:[\s-]+\|)?$/;
  private static readonly CLOZE_REGEX = /==((?:(?!==).)+)==/g;
  private static readonly IMAGE_EMBED_REGEX =
    /^!\[\[[^\]]+\.(png|jpe?g|gif|svg|bmp|webp|avif|heic|heif|tiff?)(\|[^\]]*)?\]\]$|^!\[[^\]]*\]\([^)]+\.(png|jpe?g|gif|svg|bmp|webp|avif|heic|heif|tiff?)(\s+[^)]+)?\)$/i;
  private static readonly NUMBERED_LIST_REGEX = /^\d+\.\s+(.+)$/;
  // Opening/closing fences for a V2 `decks-occlusion` codeblock.
  private static readonly OCCLUSION_FENCE_OPEN_REGEX = /^(`{3,}|~{3,})\s*decks-occlusion\s*$/;
  private static readonly CODE_FENCE_REGEX = /^(`{3,}|~{3,})/;
  // Obsidian tag syntax: Unicode letters/digits/_/-//, with at least one non-digit
  // character (so "#09-foo" and "#Trigonométrie" are tags but a pure number
  // "#123" is not).
  private static readonly HEADER_TAG_REGEX =
    /(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

  /**
   * Extract Obsidian-style tags from header text and return cleaned text.
   * - Tags ("#foo") are removed from the returned text.
   * - Returned tags are deduplicated and lowercased for case-insensitive filtering.
   */
  static extractAndStripTags(headerText: string): { cleaned: string; tags: string[] } {
    const tags: string[] = [];
    const cleaned = headerText
      .replace(FlashcardParser.HEADER_TAG_REGEX, (_match, tag: string) => {
        tags.push(tag);
        return " ";
      })
      .replace(/\s+/g, " ")
      .trim();
    const unique = Array.from(new Set(tags.map((t) => t.toLowerCase())));
    return { cleaned, tags: unique };
  }

  /**
   * Extract a header-paragraph card's notes from its body. Notes come from
   * Obsidian comments (`%%…%%`, anywhere, multi-line) and/or content after a
   * trailing thematic-break delimiter (`---` / `***` / `___` on its own line,
   * only when non-empty content follows it). Returns the cleaned back text plus
   * the combined notes (empty string when there are none).
   */
  static extractHeaderParagraphNotes(back: string): {
    back: string;
    notes: string;
  } {
    const noteParts: string[] = [];

    // 1. Obsidian comments anywhere in the body become notes; anchor tokens
    //    (`dk:` comments) carry identity and are never notes.
    let body = back.replace(/%%([\s\S]*?)%%/g, (_m, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed && !isAnchorCommentBody(trimmed)) noteParts.push(trimmed);
      return "";
    });

    // 2. A trailing thematic break with content after it splits body / notes.
    const lines = body.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
        const after = lines.slice(i + 1).join("\n").trim();
        if (after) {
          noteParts.push(after);
          body = lines.slice(0, i).join("\n");
        }
        // Only the last thematic break can act as the delimiter.
        break;
      }
    }

    return { back: body.trim(), notes: noteParts.join("\n\n").trim() };
  }

  /**
   * Flatten and dedupe tags across every header in the stack so descendant cards
   * inherit tags from each ancestor header (and their own header).
   */
  private static collectStackTags(
    headerStack: Array<{ tags: string[] }>
  ): string[] {
    const out: string[] = [];
    for (const h of headerStack) out.push(...h.tags);
    return Array.from(new Set(out));
  }

  /**
   * Pre-pass that extracts every `decks-occlusion` (V2) codeblock from the raw
   * content before the main line loop. Each block produces one card per mask.
   * The block's lines are blanked out (line count preserved) in the returned
   * content so the downstream header/table parser never misreads YAML `|` block
   * scalars or `#` comments as headings/tables.
   *
   * Cards are generated whenever the block sits inside a section header at the
   * configured `headerLevel` (mirrors header-paragraph cards); the block syntax
   * is unambiguous so it does not depend on the cloze setting. Blocks are
   * always stripped so they can't become stray header-paragraph cards.
   */
  private static extractOcclusionV2Blocks(
    content: string,
    levelSet: Set<number>
  ): { cards: ParsedFlashcard[]; maskedContent: string } {
    const lines = content.split("\n");
    const cards: ParsedFlashcard[] = [];
    const headerStack: Array<{ text: string; level: number; tags: string[] }> = [];
    let inFrontmatter = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (i === 0 && trimmed === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (trimmed === "---") inFrontmatter = false;
        continue;
      }

      const headerMatch = FlashcardParser.HEADER_REGEX.exec(line);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const { cleaned, tags } = FlashcardParser.extractAndStripTags(
          line.replace(/^#{1,6}\s+/, "")
        );
        while (
          headerStack.length > 0 &&
          headerStack[headerStack.length - 1].level >= level
        ) {
          headerStack.pop();
        }
        headerStack.push({ text: cleaned, level, tags });
        continue;
      }

      if (FlashcardParser.OCCLUSION_FENCE_OPEN_REGEX.test(trimmed)) {
        const start = i;
        const body: string[] = [];
        let end = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (FlashcardParser.CODE_FENCE_REGEX.test(lines[j].trim())) {
            end = j;
            break;
          }
          body.push(lines[j]);
        }
        // Unterminated fence: treat the rest of the file as the block body.
        if (end === -1) end = lines.length - 1;

        // Only parse when the block sits inside a header configured to be
        // parsed: title mode (0) parses anywhere, otherwise the enclosing
        // section header (stack top) must be at the configured level.
        const top = headerStack[headerStack.length - 1];
        const inConfiguredHeader =
          levelSet.has(0) || (!!top && levelSet.has(top.level));
        if (inConfiguredHeader) {
          const breadcrumb = headerStack.map((h) => h.text).join(" > ");
          const tags = FlashcardParser.collectStackTags(headerStack);
          cards.push(...OcclusionV2Parser.parse(body.join("\n"), breadcrumb, tags));
        }

        for (let k = start; k <= end; k++) lines[k] = "";
        i = end;
        continue;
      }
    }

    return { cards, maskedContent: lines.join("\n") };
  }

  /**
   * Expand a card into cloze cards if cloze markers are found, otherwise return original card.
   * When cloze markers exist, returns N cloze cards (one per highlight) and NO regular card.
   * When no cloze markers exist, returns the original card unchanged.
   */
  private static expandClozes(
    front: string,
    back: string,
    notes: string,
    type: "header-paragraph" | "table",
    breadcrumb: string,
    tags: string[],
    clozeSource: string = back,
    templateRow?: TemplateRow,
    lineTokenIds?: ReadonlyMap<number, string>
  ): ParsedFlashcard[] {
    // Line-by-line scan: cloze markers never span lines, so document order
    // (and therefore clozeOrder) is identical to a global scan, while the
    // line index enables line-scoped anchor keys.
    const matches: {
      text: string;
      order: number;
      lineIndex: number;
      indexInLine: number;
    }[] = [];
    const sourceLines = clozeSource.split("\n");
    let order = 0;
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
      const regex = new RegExp(FlashcardParser.CLOZE_REGEX.source, "g");
      let match: RegExpExecArray | null;
      let indexInLine = 0;
      while ((match = regex.exec(sourceLines[lineIndex])) !== null) {
        matches.push({ text: match[1], order, lineIndex, indexInLine });
        order++;
        indexInLine++;
      }
    }

    if (matches.length === 0) {
      // No cloze markers → a regular card. For table rows, carry templateRow
      // so tag-bound templates resolve even when the deck has cloze enabled.
      return [{
        front,
        back,
        notes,
        type,
        breadcrumb,
        tags: [...tags],
        ...(templateRow ? { templateRow } : {}),
      }];
    }

    return matches.map((m) => {
      const tokenId = lineTokenIds?.get(m.lineIndex);
      return {
        front,
        back,
        notes,
        type: "cloze" as const,
        breadcrumb,
        tags: [...tags],
        clozeText: m.text,
        clozeOrder: m.order,
        clozeLineIndex: m.indexInLine,
        ...(tokenId ? { anchorKey: clozeBindingKey(tokenId, m.indexInLine) } : {}),
        ...(templateRow ? { templateRow } : {}),
      };
    });
  }

  /**
   * Parse flashcards from content string (optimized single-pass parsing)
   * @param content - Markdown content to parse
   * @param headerLevel - Target header level(s) for header-paragraph flashcards
   *   (1-6, default: 2), or 0 for title mode. Accepts a single level or a set of levels.
   * @param fileTitle - File title used as card front when in title mode (level 0)
   * @param clozeEnabled - When true, ==highlighted== text generates cloze cards
   * @param examEnabled - When true, a task list under a heading generates a
   *   multiple-choice card
   * @returns Array of parsed flashcards
   */
  static parseFlashcardsFromContent(
    content: string,
    headerLevel: number | number[] = 2,
    fileTitle?: string,
    clozeEnabled = false,
    examEnabled = false
  ): ParsedFlashcard[] {
    const levelSet = new Set(
      Array.isArray(headerLevel) ? headerLevel : [headerLevel]
    );

    // Pre-pass: pull out V2 occlusion codeblocks and strip them from the
    // content so they never reach the header/table parser below.
    const occlusion = FlashcardParser.extractOcclusionV2Blocks(content, levelSet);
    content = occlusion.maskedContent;
    const occlusionCards = occlusion.cards;

    if (levelSet.has(0)) {
      if (!fileTitle) return occlusionCards;
      const back = stripAnchorTokens(
        FlashcardParser.stripFrontmatter(content)
      ).trim();
      const titleId = FlashcardParser.extractDecksId(content);
      if (clozeEnabled) {
        const cards = FlashcardParser.expandClozes(
          fileTitle, back, "", "header-paragraph", "", []
        );
        if (titleId) {
          for (const card of cards) {
            card.anchorKey =
              card.type === "cloze" && card.clozeOrder !== undefined
                ? titleClozeBindingKey(titleId, card.clozeOrder)
                : titleBindingKey(titleId);
          }
        }
        return [...occlusionCards, ...cards];
      }
      return [
        ...occlusionCards,
        {
          front: fileTitle,
          back,
          notes: "",
          type: "header-paragraph",
          breadcrumb: "",
          tags: [],
          ...(titleId ? { anchorKey: titleBindingKey(titleId) } : {}),
        },
      ];
    }

    const lines = content.split("\n");
    const flashcards: ParsedFlashcard[] = [...occlusionCards];

    // Single pass through lines for both table and header parsing
    let inTable = false;
    let tableRowCount = 0;
    let currentTableHeaders: string[] = [];
    let currentHeader: { text: string; level: number; tags: string[] } | null = null;
    let currentContent: string[] = [];
    let inFrontmatter = false;
    let skipNextParagraph = false;
    let inCodeBlock = false;
    // Precomputed per-section: true when the current header's section contains a
    // table and no other prose (in any order). Tables only become row-cards when
    // this holds; a mixed section becomes one header-paragraph card instead.
    let sectionIsTableOnly = false;

    // Header stack for breadcrumb tracking (text is already tag-stripped)
    const headerStack: Array<{ text: string; level: number; tags: string[] }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Handle frontmatter
      if (i === 0 && trimmedLine === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (trimmedLine === "---") {
          inFrontmatter = false;
        }
        continue;
      }

      // Fenced code blocks are literal: a `## x` or `| a | b |` inside a fence is
      // content, not a header/table. Toggle on the fence line and keep every line
      // (including the fences) as part of the current section's body.
      if (FlashcardParser.CODE_FENCE_REGEX.test(trimmedLine)) {
        inCodeBlock = !inCodeBlock;
        if (currentHeader) currentContent.push(line);
        continue;
      }
      if (inCodeBlock) {
        if (currentHeader) {
          if (trimmedLine === "" && currentContent.length === 0) continue;
          currentContent.push(line);
        }
        continue;
      }

      // Check for table rows
      if (FlashcardParser.TABLE_ROW_REGEX.test(trimmedLine)) {
        // Only parse the table into row-cards when it is the sole content of a
        // correctly-levelled section (no other prose, in any order).
        if (
          currentHeader &&
          levelSet.has(currentHeader.level) &&
          sectionIsTableOnly
        ) {
          if (!inTable) {
            inTable = true;
            tableRowCount = 0;
            currentTableHeaders = [];
          }

          tableRowCount++;

          // Capture the header row (row 1) for named-column template merges;
          // skip it and the separator (row 2) from card generation.
          if (tableRowCount === 1) {
            currentTableHeaders = splitTableLine(trimmedLine.slice(1, -1)).map(
              (cell) => unescapeTableCell(stripAnchorTokens(cell).trim()),
            );
            continue;
          }
          if (tableRowCount === 2) {
            continue;
          }

          // Parse table row. Pipes preceded by a backslash are treated as
          // literal cell content (`\|` → `|`); `<br>` is treated as a newline.
          // Anchor tokens are extracted (the first t-role token in any cell
          // carries the row's identity) and stripped before cell processing.
          let rowTokenId: string | undefined;
          const cells = splitTableLine(trimmedLine.slice(1, -1)).map(
            (cell) => {
              const { cleaned, tokens } = extractAnchorTokens(cell);
              if (!rowTokenId) {
                rowTokenId = tokens.find((t) => t.role === "t")?.id;
              }
              return unescapeTableCell(cleaned.trim());
            },
          );

          if (cells.length >= 1 && cells[0]) {
            const back = cells[1] ?? "";
            const breadcrumb = headerStack.map((h) => h.text).join(" > ");
            const rowNotes = cells.length >= 3 ? (cells[2] || "") : "";
            const rowTags = FlashcardParser.collectStackTags(headerStack);
            const frontIsCloze =
              clozeEnabled &&
              new RegExp(FlashcardParser.CLOZE_REGEX.source).test(cells[0]);

            // Capture row data so a tag-bound template can merge it at render
            // time (binding tags come from the header).
            const templateRow = {
              headers: currentTableHeaders,
              cells,
            };
            const rowCards: ParsedFlashcard[] = [];
            if (frontIsCloze) {
              // The cloze lives in the front cell → a front-only cloze (blanked on
              // the front). Other columns stay available to a bound template; the
              // row still carries templateRow so the template can render them.
              rowCards.push(
                ...FlashcardParser.expandClozes(
                  cells[0], "", rowNotes, "table", breadcrumb, rowTags, cells[0], templateRow
                )
              );
            } else if (back.length > 0) {
              // Standard 2-column row (front + back; the back may hold a cloze).
              if (clozeEnabled) {
                rowCards.push(
                  ...FlashcardParser.expandClozes(
                    cells[0], back, rowNotes, "table", breadcrumb, rowTags, back, templateRow
                  )
                );
              } else {
                rowCards.push({
                  front: cells[0], back, notes: rowNotes, type: "table", breadcrumb, tags: rowTags,
                  templateRow,
                });
              }
            }
            // else: a non-cloze row with no back is an incomplete row — ignore.
            if (rowTokenId) {
              for (const rowCard of rowCards) {
                rowCard.anchorKey =
                  rowCard.type === "cloze" && rowCard.clozeOrder !== undefined
                    ? tableBindingKey(rowTokenId, rowCard.clozeOrder)
                    : tableBindingKey(rowTokenId);
              }
            }
            flashcards.push(...rowCards);
          }
        } else {
          // Table under wrong header level or has non-table content - treat as regular content
          if (inTable) {
            inTable = false;
            tableRowCount = 0;
          }
          if (currentHeader) {
            // Skip empty lines at the beginning of content
            if (trimmedLine === "" && currentContent.length === 0) {
              continue;
            }
            currentContent.push(line);
          }
        }
      } else {
        // Not a table row, end table processing
        if (inTable) {
          inTable = false;
          tableRowCount = 0;
        }

        // Check for headers
        const headerMatch = FlashcardParser.HEADER_REGEX.exec(line);
        if (headerMatch) {
          const currentHeaderLevel = headerMatch[1].length;
          const rawHeaderText = stripAnchorTokens(
            line.replace(/^#{1,6}\s+/, "")
          );
          const { cleaned: headerText, tags: headerTags } =
            FlashcardParser.extractAndStripTags(rawHeaderText);

          // Check for title headers to skip
          if (line.match(/^#\s+/) && line.toLowerCase().includes("flashcard")) {
            skipNextParagraph = true;
            // Build breadcrumb excluding the card's own header (last stack item)
            const breadcrumb = headerStack
              .slice(0, -1)
              .map((h) => h.text)
              .join(" > ");
            const stackTags = FlashcardParser.collectStackTags(headerStack);
            FlashcardParser.finalizeCurrentHeader(
              currentHeader,
              currentContent,
              flashcards,
              levelSet,
              breadcrumb,
              stackTags,
              clozeEnabled,
              examEnabled
            );
            currentHeader = null;
            currentContent = [];
            sectionIsTableOnly = false;
            // Update header stack for H1 flashcard title
            while (
              headerStack.length > 0 &&
              headerStack[headerStack.length - 1].level >= currentHeaderLevel
            ) {
              headerStack.pop();
            }
            headerStack.push({ text: headerText, level: currentHeaderLevel, tags: headerTags });
            continue;
          }

          // Build breadcrumb excluding the card's own header (last stack item)
          const breadcrumb = headerStack
            .slice(0, -1)
            .map((h) => h.text)
            .join(" > ");
          const stackTags = FlashcardParser.collectStackTags(headerStack);

          // Finalize previous header
          FlashcardParser.finalizeCurrentHeader(
            currentHeader,
            currentContent,
            flashcards,
            levelSet,
            breadcrumb,
            stackTags,
            clozeEnabled,
            examEnabled
          );

          // Update header stack: pop all headers at same or deeper level
          while (
            headerStack.length > 0 &&
            headerStack[headerStack.length - 1].level >= currentHeaderLevel
          ) {
            headerStack.pop();
          }
          // Push current header onto stack (text is tag-stripped)
          headerStack.push({ text: headerText, level: currentHeaderLevel, tags: headerTags });

          // Start new header (text holds the original line for downstream front-text extraction)
          currentHeader = {
            text: line,
            level: currentHeaderLevel,
            tags: headerTags,
          };
          currentContent = [];
          sectionIsTableOnly = FlashcardParser.isSectionTableOnly(lines, i + 1);
          skipNextParagraph = false;
        } else if (skipNextParagraph) {
          if (trimmedLine === "") {
            skipNextParagraph = false;
          }
        } else if (currentHeader) {
          // Skip empty lines at the beginning of content
          if (trimmedLine === "" && currentContent.length === 0) {
            continue;
          }
          currentContent.push(line);
        }
      }
    }

    // Finalize last header (exclude card's own header from breadcrumb)
    const finalBreadcrumb = headerStack
      .slice(0, -1)
      .map((h) => h.text)
      .join(" > ");
    const finalStackTags = FlashcardParser.collectStackTags(headerStack);
    FlashcardParser.finalizeCurrentHeader(
      currentHeader,
      currentContent,
      flashcards,
      levelSet,
      finalBreadcrumb,
      finalStackTags,
      clozeEnabled,
      examEnabled
    );

    return flashcards;
  }

  private static stripFrontmatter(content: string): string {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---") return content;
    const end = lines.indexOf("---", 1);
    if (end === -1) return content;
    return lines.slice(end + 1).join("\n");
  }

  /** Read the `decks-id` frontmatter property (title-mode card identity). */
  private static extractDecksId(content: string): string | null {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---") return null;
    const end = lines.indexOf("---", 1);
    if (end === -1) return null;
    for (let i = 1; i < end; i++) {
      const match = /^decks-id:\s*("?)([A-Za-z0-9_-]+)\1\s*$/.exec(lines[i]);
      if (match) return match[2];
    }
    return null;
  }

  /**
   * Expand an image occlusion block into one card per numbered list item.
   * Each list item becomes one card regardless of how many ==cloze== markers it contains.
   * Items without ==cloze== markers use the full item text as the cloze text.
   */
  private static expandImageOcclusion(
    imageEmbed: string,
    back: string,
    listItems: string[],
    breadcrumb: string,
    tags: string[],
    itemAnchorIds?: (string | undefined)[]
  ): ParsedFlashcard[] {
    const cards: ParsedFlashcard[] = [];
    let order = 0;

    for (const item of listItems) {
      const trimmed = item.trim();
      if (!trimmed) continue;

      const clozeText = trimmed.replace(/==((?:(?!==).)+)==/g, "$1");
      const anchorId = itemAnchorIds?.[order];
      cards.push({
        front: imageEmbed,
        back,
        notes: "",
        type: "image-occlusion",
        breadcrumb,
        tags: [...tags],
        clozeText,
        clozeOrder: order,
        ...(anchorId ? { anchorKey: occlusionBindingKey(anchorId) } : {}),
      });
      order++;
    }

    return cards;
  }

  /**
   * Detect if content is an image occlusion block:
   * first non-empty line is an image embed, remaining non-empty lines are a numbered list.
   * Returns the image embed and list item texts, or null if not matched.
   */
  private static detectImageOcclusion(
    contentLines: string[]
  ): { imageEmbed: string; listItems: string[] } | null {
    const nonEmptyLines = contentLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (nonEmptyLines.length < 2) return null;

    if (!FlashcardParser.IMAGE_EMBED_REGEX.test(nonEmptyLines[0])) return null;

    const listItems: string[] = [];
    for (let i = 1; i < nonEmptyLines.length; i++) {
      const match = FlashcardParser.NUMBERED_LIST_REGEX.exec(nonEmptyLines[i]);
      if (!match) return null;
      listItems.push(match[1]);
    }

    return { imageEmbed: nonEmptyLines[0], listItems };
  }

  /**
   * Helper to finalize current header flashcard
   */
  /**
   * Scan a header section (from `startIndex` up to the next real header or EOF,
   * respecting code fences) and decide whether it is a pure table section: it
   * contains at least one table row and no other prose. Blank lines and lone
   * thematic-break lines (`---`/`***`/`___`) are ignored; a fenced code block
   * counts as prose (so a fenced table never becomes row-cards).
   */
  private static isSectionTableOnly(
    lines: string[],
    startIndex: number
  ): boolean {
    let sawTable = false;
    let sawProse = false;
    let inCodeBlock = false;
    for (let i = startIndex; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (FlashcardParser.CODE_FENCE_REGEX.test(trimmed)) {
        inCodeBlock = !inCodeBlock;
        sawProse = true;
        continue;
      }
      if (inCodeBlock) {
        if (trimmed !== "") sawProse = true;
        continue;
      }
      if (FlashcardParser.HEADER_REGEX.test(lines[i])) break;
      if (trimmed === "") continue;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue;
      if (FlashcardParser.TABLE_ROW_REGEX.test(trimmed)) {
        sawTable = true;
      } else {
        sawProse = true;
      }
    }
    return sawTable && !sawProse;
  }

  private static finalizeCurrentHeader(
    currentHeader: { text: string; level: number; tags: string[] } | null,
    currentContent: string[],
    flashcards: ParsedFlashcard[],
    targetLevels: Set<number>,
    breadcrumb: string,
    stackTags: string[],
    clozeEnabled = false,
    examEnabled = false
  ): void {
    if (
      currentHeader &&
      currentContent.length > 0 &&
      targetLevels.has(currentHeader.level)
    ) {
      // Anchor tokens are identity markers, not content: strip them before
      // any body processing so tokened and clean sources parse identically.
      const { lines: cleanContent, anchors } = extractLineAnchors(currentContent);

      // A header section whose only content is blank lines or a thematic break
      // (e.g. a trailing `---` separator left after its table) is not a real card.
      const hasRealContent = cleanContent.some((line) => {
        const t = line.trim();
        return t !== "" && !/^(-{3,}|\*{3,}|_{3,})$/.test(t);
      });
      if (!hasRealContent) return;

      const rawFront = stripAnchorTokens(
        currentHeader.text.replace(/^#{1,6}\s+/, "")
      );
      const { cleaned: front } = FlashcardParser.extractAndStripTags(rawFront);
      const back = cleanContent.join("\n").trim();
      const tags = [...stackTags];

      // Image occlusion syntax is unambiguous, so it parses regardless of
      // the cloze setting.
      const imageOcclusion = FlashcardParser.detectImageOcclusion(cleanContent);
      if (imageOcclusion) {
        // Map o-role anchors to item ordinals: every numbered non-empty line
        // is an item, in document order (detectImageOcclusion guarantees it).
        const anchorByLine = new Map<number, string>();
        for (const anchor of anchors) {
          if (anchor.role === "o") anchorByLine.set(anchor.lineIndex, anchor.id);
        }
        const itemAnchorIds: (string | undefined)[] = [];
        for (let li = 0; li < cleanContent.length; li++) {
          const trimmed = cleanContent[li].trim();
          if (trimmed === "") continue;
          if (FlashcardParser.NUMBERED_LIST_REGEX.test(trimmed)) {
            itemAnchorIds.push(anchorByLine.get(li));
          }
        }
        const backWithoutImage = cleanContent
          .filter((l) => l.trim() !== imageOcclusion.imageEmbed)
          .join("\n")
          .trim();
        const imageOcclusionBreadcrumb = breadcrumb
          ? `${breadcrumb} > ${front}`
          : front;
        const expanded = FlashcardParser.expandImageOcclusion(
          imageOcclusion.imageEmbed, backWithoutImage, imageOcclusion.listItems, imageOcclusionBreadcrumb, tags, itemAnchorIds
        );
        flashcards.push(...expanded);
        return;
      }

      const headerAnchor = anchors.find((a) => a.role === "h");
      const headerKey = headerAnchor
        ? headerBindingKey(headerAnchor.id)
        : undefined;

      const { back: cleanBack, notes } =
        FlashcardParser.extractHeaderParagraphNotes(back);

      // Task-list question rule: a body classifying as a valid question wins
      // outright over cloze/plain. Invalid or plain bodies fall through to the
      // existing paths unchanged (no silent question creation, no data loss).
      // The back stays byte-identical to the header-paragraph fallback so a
      // type flip between mixed plugin versions only flaps the type column.
      // Role separation: a question adopts only its own q token; the dormant
      // h token stays inert for it (and vice versa).
      if (examEnabled && classifyExamBody(cleanBack).kind === "mcq") {
        const questionAnchor = anchors.find((a) => a.role === "q");
        flashcards.push({
          front,
          back: cleanBack,
          notes,
          type: "multiple-choice",
          breadcrumb,
          tags,
          ...(questionAnchor
            ? { anchorKey: questionBindingKey(questionAnchor.id) }
            : {}),
        });
        return;
      }

      if (clozeEnabled) {
        const lineTokenIds = FlashcardParser.clozeLineTokenMap(
          cleanContent,
          anchors,
          cleanBack
        );
        const expanded = FlashcardParser.expandClozes(
          front, cleanBack, notes, "header-paragraph", breadcrumb, tags,
          cleanBack, undefined, lineTokenIds
        );
        if (headerKey) {
          for (const card of expanded) {
            if (card.type === "header-paragraph") card.anchorKey = headerKey;
          }
        }
        flashcards.push(...expanded);
      } else {
        flashcards.push({
          front,
          back: cleanBack,
          notes,
          type: "header-paragraph",
          breadcrumb,
          tags,
          ...(headerKey ? { anchorKey: headerKey } : {}),
        });
      }
    }
  }

  /**
   * Map `c`-role anchors onto the final cloze source's line indices. Notes
   * extraction can reshape the body (multi-line comments, trailing notes), so
   * each entry is kept only when its line provably survived unchanged —
   * anything else drops the entry and the cloze falls back to content
   * identity.
   */
  private static clozeLineTokenMap(
    strippedLines: string[],
    anchors: LineAnchor[],
    cleanBack: string
  ): Map<number, string> {
    const map = new Map<number, string>();
    const clozeAnchors = anchors.filter((a) => a.role === "c");
    if (clozeAnchors.length === 0) return map;
    const cleanLines = cleanBack.split("\n");
    const withoutComments = (line: string): string =>
      line.replace(/%%(?:(?!%%).)*%%/g, "");
    for (const anchor of clozeAnchors) {
      if (anchor.lineIndex >= cleanLines.length) continue;
      if (
        withoutComments(strippedLines[anchor.lineIndex]) !==
        cleanLines[anchor.lineIndex]
      ) {
        continue;
      }
      map.set(anchor.lineIndex, anchor.id);
    }
    return map;
  }
}
