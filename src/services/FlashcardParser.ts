import { splitTableLine, unescapeTableCell } from "../utils/markdown-table";
import type { TemplateRow } from "../database/types";
import { OcclusionV2Parser } from "./occlusion/OcclusionV2Parser";

export interface ParsedFlashcard {
  front: string;
  back: string;
  notes: string;
  type: "header-paragraph" | "table" | "cloze" | "image-occlusion" | "image-occlusion-v2" | "spatial";
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

    // 1. Obsidian comments anywhere in the body become notes.
    let body = back.replace(/%%([\s\S]*?)%%/g, (_m, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) noteParts.push(trimmed);
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
   * Cards are only generated when `clozeEnabled` and the block sits inside a
   * section header at the configured `headerLevel` (mirrors legacy occlusion and
   * header-paragraph cards). Blocks are always stripped so they can't become
   * stray header-paragraph cards.
   */
  private static extractOcclusionV2Blocks(
    content: string,
    clozeEnabled: boolean,
    headerLevel: number
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
          headerLevel === 0 || (!!top && top.level === headerLevel);
        if (clozeEnabled && inConfiguredHeader) {
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
    templateRow?: TemplateRow
  ): ParsedFlashcard[] {
    const matches: { text: string; index: number }[] = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(FlashcardParser.CLOZE_REGEX.source, "g");

    while ((match = regex.exec(clozeSource)) !== null) {
      matches.push({ text: match[1], index: matches.length });
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

    return matches.map((m) => ({
      front,
      back,
      notes,
      type: "cloze" as const,
      breadcrumb,
      tags: [...tags],
      clozeText: m.text,
      clozeOrder: m.index,
      ...(templateRow ? { templateRow } : {}),
    }));
  }

  /**
   * Parse flashcards from content string (optimized single-pass parsing)
   * @param content - Markdown content to parse
   * @param headerLevel - Target header level for header-paragraph flashcards (1-6, default: 2), or 0 for title mode
   * @param fileTitle - File title used as card front when headerLevel is 0 (title mode)
   * @param clozeEnabled - When true, ==highlighted== text generates cloze cards
   * @returns Array of parsed flashcards
   */
  static parseFlashcardsFromContent(
    content: string,
    headerLevel = 2,
    fileTitle?: string,
    clozeEnabled = false
  ): ParsedFlashcard[] {
    // Pre-pass: pull out V2 occlusion codeblocks and strip them from the
    // content so they never reach the header/table parser below.
    const occlusion = FlashcardParser.extractOcclusionV2Blocks(content, clozeEnabled, headerLevel);
    content = occlusion.maskedContent;
    const occlusionCards = occlusion.cards;

    if (headerLevel === 0) {
      if (!fileTitle) return occlusionCards;
      const back = FlashcardParser.stripFrontmatter(content).trim();
      if (clozeEnabled) {
        return [
          ...occlusionCards,
          ...FlashcardParser.expandClozes(fileTitle, back, "", "header-paragraph", "", []),
        ];
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
    let hasNonTableContent = false;

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

      // Check for table rows
      if (FlashcardParser.TABLE_ROW_REGEX.test(trimmedLine)) {
        // Only parse table if we have a current header with the correct level AND no non-table content
        if (
          currentHeader &&
          currentHeader.level === headerLevel &&
          !hasNonTableContent
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
              (cell) => unescapeTableCell(cell.trim()),
            );
            continue;
          }
          if (tableRowCount === 2) {
            continue;
          }

          // Parse table row. Pipes preceded by a backslash are treated as
          // literal cell content (`\|` → `|`); `<br>` is treated as a newline.
          const cells = splitTableLine(trimmedLine.slice(1, -1)).map(
            (cell) => unescapeTableCell(cell.trim()),
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
            if (frontIsCloze) {
              // The cloze lives in the front cell → a front-only cloze (blanked on
              // the front). Other columns stay available to a bound template; the
              // row still carries templateRow so the template can render them.
              flashcards.push(
                ...FlashcardParser.expandClozes(
                  cells[0], "", rowNotes, "table", breadcrumb, rowTags, cells[0], templateRow
                )
              );
            } else if (back.length > 0) {
              // Standard 2-column row (front + back; the back may hold a cloze).
              if (clozeEnabled) {
                flashcards.push(
                  ...FlashcardParser.expandClozes(
                    cells[0], back, rowNotes, "table", breadcrumb, rowTags, back, templateRow
                  )
                );
              } else {
                flashcards.push({
                  front: cells[0], back, notes: rowNotes, type: "table", breadcrumb, tags: rowTags,
                  templateRow,
                });
              }
            }
            // else: a non-cloze row with no back is an incomplete row — ignore.
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
          const rawHeaderText = line.replace(/^#{1,6}\s+/, "");
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
              headerLevel,
              breadcrumb,
              stackTags,
              clozeEnabled
            );
            currentHeader = null;
            currentContent = [];
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
            headerLevel,
            breadcrumb,
            stackTags,
            clozeEnabled
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
          hasNonTableContent = false;
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
          // Mark that we have non-table content under this header
          hasNonTableContent = true;
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
      headerLevel,
      finalBreadcrumb,
      finalStackTags,
      clozeEnabled
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
    tags: string[]
  ): ParsedFlashcard[] {
    const cards: ParsedFlashcard[] = [];
    let order = 0;

    for (const item of listItems) {
      const trimmed = item.trim();
      if (!trimmed) continue;

      const clozeText = trimmed.replace(/==((?:(?!==).)+)==/g, "$1");
      cards.push({
        front: imageEmbed,
        back,
        notes: "",
        type: "image-occlusion",
        breadcrumb,
        tags: [...tags],
        clozeText,
        clozeOrder: order,
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
  private static finalizeCurrentHeader(
    currentHeader: { text: string; level: number; tags: string[] } | null,
    currentContent: string[],
    flashcards: ParsedFlashcard[],
    targetHeaderLevel: number,
    breadcrumb: string,
    stackTags: string[],
    clozeEnabled = false
  ): void {
    if (
      currentHeader &&
      currentContent.length > 0 &&
      currentHeader.level === targetHeaderLevel
    ) {
      // A header section whose only content is blank lines or a thematic break
      // (e.g. a trailing `---` separator left after its table) is not a real card.
      const hasRealContent = currentContent.some((line) => {
        const t = line.trim();
        return t !== "" && !/^(-{3,}|\*{3,}|_{3,})$/.test(t);
      });
      if (!hasRealContent) return;

      const rawFront = currentHeader.text.replace(/^#{1,6}\s+/, "");
      const { cleaned: front } = FlashcardParser.extractAndStripTags(rawFront);
      const back = currentContent.join("\n").trim();
      const tags = [...stackTags];

      if (clozeEnabled) {
        const imageOcclusion = FlashcardParser.detectImageOcclusion(currentContent);
        if (imageOcclusion) {
          const backWithoutImage = currentContent
            .filter((l) => l.trim() !== imageOcclusion.imageEmbed)
            .join("\n")
            .trim();
          const imageOcclusionBreadcrumb = breadcrumb
            ? `${breadcrumb} > ${front}`
            : front;
          const expanded = FlashcardParser.expandImageOcclusion(
            imageOcclusion.imageEmbed, backWithoutImage, imageOcclusion.listItems, imageOcclusionBreadcrumb, tags
          );
          flashcards.push(...expanded);
          return;
        }

        const { back: clozeBack, notes: clozeNotes } =
          FlashcardParser.extractHeaderParagraphNotes(back);
        const expanded = FlashcardParser.expandClozes(
          front, clozeBack, clozeNotes, "header-paragraph", breadcrumb, tags
        );
        flashcards.push(...expanded);
      } else {
        const { back: cleanBack, notes } =
          FlashcardParser.extractHeaderParagraphNotes(back);
        flashcards.push({
          front,
          back: cleanBack,
          notes,
          type: "header-paragraph",
          breadcrumb,
          tags,
        });
      }
    }
  }
}
