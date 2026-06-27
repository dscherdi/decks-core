import type { RawDatabase } from "../../FlashcardSynchronizer";
import { AnkiSanitizer } from "./AnkiSanitizer";
import type { HtmlToMarkdown, SanitizeOptions } from "./AnkiSanitizer";
import { AnkiTemplateEngine } from "./AnkiTemplateEngine";
import type { AnkiTemplateData } from "./AnkiTemplateEngine";
import { AnkiTemplateExporter } from "./AnkiTemplateExporter";
import type { AnkiTemplateFile } from "./AnkiTemplateExporter";
import { AnkiOcclusionExtractor } from "./AnkiOcclusionExtractor";
import { readProtoScalars } from "./proto";
import { hasBlockMarkdown } from "../../../utils/markdown-table";
import type { AnkiRevlogRow } from "./AnkiHistoryImporter";
import type {
  AnkiDeckMeta,
  AnkiModel,
  AnkiModelField,
  AnkiParseResult,
  AnkiParsedCard,
  AnkiScheduling,
  AnkiTemplate,
} from "./AnkiTypes";
import type { OcclusionMask } from "../../occlusion/OcclusionV2.types";
import type { SqlJsValue } from "../../../database/sql-types";

// Anki joins a note's field values with the unit separator.
const FIELD_SEPARATOR = "\x1f";

// Field-name match for picking a readable header on cloze notes.
// Field names that are bookkeeping ids, never used as content.
const ID_FIELD = /^(id|guid|uid|key)$/i;

export interface AnkiParseOptions {
  hintLabel?: string;
  htmlToMarkdown?: HtmlToMarkdown;
  // Reads a media file's text content (used for image-occlusion mask SVGs).
  // Without it, image-occlusion notes are skipped.
  getMediaText?: (filename: string) => string | undefined;
}

interface RowContext {
  row: RawCardNote;
  model: AnkiModel;
  deckName: string;
  fieldMap: Map<string, string>;
}

/**
 * Reads an Anki collection (sql.js `Database` satisfies {@link RawDatabase}) and
 * produces normalized {@link AnkiParsedCard}s. Pure logic — the plugin handles
 * unzipping and instantiating the database.
 */
export class AnkiCollectionParser {
  // Compactness caps for escalating a basic card to a table cell (see fitsTable).
  private static readonly MAX_TABLE_LINES = 4;
  private static readonly MAX_TABLE_CHARS = 300;

  static parse(db: RawDatabase, options: AnkiParseOptions = {}): AnkiParseResult {
    const sanitize: SanitizeOptions = {
      hintLabel: options.hintLabel ?? "hint",
      htmlToMarkdown: options.htmlToMarkdown,
    };
    const models = AnkiCollectionParser.readModels(db);
    const decks = AnkiCollectionParser.readDecks(db);

    const cards: AnkiParsedCard[] = [];
    const noteIds = new Set<number>();
    const mediaFiles = new Set<string>();
    const templateFiles = new Map<string, AnkiTemplateFile>();
    let withHistory = 0;
    const collect = (card: AnkiParsedCard): void => {
      noteIds.add(card.noteId);
      for (const m of card.media) mediaFiles.add(m);
      if (!AnkiCollectionParser.isNew(card.scheduling)) withHistory++;
      cards.push(card);
    };

    const templateRows: RowContext[] = [];
    const ioRows: RowContext[] = [];

    const rows = AnkiCollectionParser.readCardNoteRows(db);
    for (const row of rows) {
      const model = models.get(row.mid);
      if (!model) continue;
      const deckName = decks.get(row.did) ?? "Default";
      const fieldMap = AnkiCollectionParser.mapFields(model, AnkiCollectionParser.splitFields(row.flds));
      const ctx: RowContext = { row, model, deckName, fieldMap };

      if (AnkiCollectionParser.isImageOcclusion(model)) {
        ioRows.push(ctx);
      } else if (model.type === 1) {
        const c = AnkiCollectionParser.buildClozeCard(row, model, fieldMap, deckName, sanitize, templateFiles);
        if (c) collect(c);
      } else if (model.flds.length > 2 && AnkiTemplateExporter.hasRichCss(model.css)) {
        templateRows.push(ctx); // CSS-layout multi-field → HTML template-bound table row
      } else {
        const c = AnkiCollectionParser.buildBasicCard(row, model, fieldMap, deckName, sanitize);
        if (c) collect(c);
      }
    }

    for (const card of AnkiCollectionParser.buildTemplateCards(templateRows, sanitize, templateFiles)) {
      collect(card);
    }
    for (const card of AnkiCollectionParser.buildOcclusionCards(ioRows, options.getMediaText)) {
      collect(card);
    }

    const deckNames = Array.from(new Set(cards.map((c) => c.deckName))).sort();
    return {
      cards,
      deckNames,
      noteCount: noteIds.size,
      cardCount: cards.length,
      withHistory,
      mediaFiles: Array.from(mediaFiles).sort(),
      templateFiles: Array.from(templateFiles.values()),
    };
  }

  // --- Collection JSON (the single `col` row) ---

  private static readModels(db: RawDatabase): Map<string, AnkiModel> {
    const json = AnkiCollectionParser.readColField(db, "models");
    const result = new Map<string, AnkiModel>();
    const parsed: unknown = JSON.parse(json || "{}");
    if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const model = AnkiCollectionParser.coerceModel(id, value);
        if (model) result.set(id, model);
      }
    }
    // Schema 18 (`collection.anki21b`) leaves `col.models` empty — note types live
    // in normalized tables instead.
    if (result.size === 0) return AnkiCollectionParser.readModelsV18(db);
    return result;
  }

  private static readDecks(db: RawDatabase): Map<string, string> {
    const json = AnkiCollectionParser.readColField(db, "decks");
    const result = new Map<string, string>();
    const parsed: unknown = JSON.parse(json || "{}");
    if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === "object") {
          const name = (value as AnkiDeckMeta).name;
          if (typeof name === "string") result.set(id, name);
        }
      }
    }
    // Schema 18 leaves `col.decks` empty — decks live in the `decks` table, with
    // `\x1f` (not `::`) separating the hierarchy.
    if (result.size === 0) return AnkiCollectionParser.readDecksV18(db);
    return result;
  }

  // --- Schema 18 (collection.anki21b): models/decks in normalized tables ---

  private static readModelsV18(db: RawDatabase): Map<string, AnkiModel> {
    const result = new Map<string, AnkiModel>();
    try {
      const fieldsByNt = new Map<string, AnkiModelField[]>();
      for (const row of AnkiCollectionParser.queryRows(db, "SELECT ntid, ord, name FROM fields ORDER BY ntid, ord")) {
        const ntid = String(row.ntid);
        const list = fieldsByNt.get(ntid) ?? [];
        list.push({ name: typeof row.name === "string" ? row.name : "", ord: Number(row.ord) });
        fieldsByNt.set(ntid, list);
      }

      const tmplsByNt = new Map<string, AnkiTemplate[]>();
      for (const row of AnkiCollectionParser.queryRows(db, "SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord")) {
        const ntid = String(row.ntid);
        const cfg = readProtoScalars(AnkiCollectionParser.asBytes(row.config));
        const list = tmplsByNt.get(ntid) ?? [];
        list.push({
          name: typeof row.name === "string" ? row.name : "",
          ord: Number(row.ord),
          qfmt: cfg.string(1) ?? "",
          afmt: cfg.string(2) ?? "",
        });
        tmplsByNt.set(ntid, list);
      }

      for (const row of AnkiCollectionParser.queryRows(db, "SELECT id, name, config FROM notetypes")) {
        const id = String(row.id);
        const cfg = readProtoScalars(AnkiCollectionParser.asBytes(row.config));
        result.set(id, {
          id,
          name: typeof row.name === "string" ? row.name : "",
          type: cfg.uint(1) ?? 0, // NotetypeConfig.kind: 1 = cloze, absent ⇒ 0 normal
          flds: fieldsByNt.get(id) ?? [],
          tmpls: tmplsByNt.get(id) ?? [],
          css: cfg.string(3),
        });
      }
    } catch {
      // Tables absent / unexpected shape — leave empty (cards then skip cleanly).
    }
    return result;
  }

  private static readDecksV18(db: RawDatabase): Map<string, string> {
    const result = new Map<string, string>();
    try {
      for (const row of AnkiCollectionParser.queryRows(db, "SELECT id, name FROM decks")) {
        const name = typeof row.name === "string" ? row.name.split(FIELD_SEPARATOR).join("::") : "";
        result.set(String(row.id), name);
      }
    } catch {
      // No `decks` table — leave empty.
    }
    return result;
  }

  private static queryRows(db: RawDatabase, sql: string): Array<Record<string, SqlJsValue>> {
    const stmt = db.prepare(sql);
    const rows: Array<Record<string, SqlJsValue>> = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  private static asBytes(value: SqlJsValue): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array();
  }

  private static readColField(db: RawDatabase, column: "models" | "decks"): string {
    const stmt = db.prepare(`SELECT ${column} AS value FROM col LIMIT 1`);
    try {
      if (!stmt.step()) return "";
      const value = stmt.getAsObject().value;
      return typeof value === "string" ? value : "";
    } finally {
      stmt.free();
    }
  }

  private static coerceModel(id: string, value: unknown): AnkiModel | null {
    if (!value || typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    const flds = Array.isArray(obj.flds)
      ? obj.flds
          .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
          .map((f) => ({ name: String(f.name ?? ""), ord: typeof f.ord === "number" ? f.ord : undefined }))
      : [];
    const tmpls = Array.isArray(obj.tmpls)
      ? obj.tmpls
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map<AnkiTemplate>((t, index) => ({
            name: String(t.name ?? ""),
            ord: typeof t.ord === "number" ? t.ord : index,
            qfmt: String(t.qfmt ?? ""),
            afmt: String(t.afmt ?? ""),
          }))
      : [];
    return {
      id,
      name: String(obj.name ?? ""),
      type: typeof obj.type === "number" ? obj.type : 0,
      flds,
      tmpls,
      css: typeof obj.css === "string" ? obj.css : undefined,
    };
  }

  // --- cards ⋈ notes ---

  private static readCardNoteRows(db: RawDatabase): Array<RawCardNote> {
    const sql =
      "SELECT c.id AS cid, c.nid AS nid, c.did AS did, c.ord AS ord, " +
      "c.type AS ctype, c.queue AS queue, c.due AS due, c.ivl AS ivl, " +
      "c.factor AS factor, c.reps AS reps, c.lapses AS lapses, c.data AS data, " +
      "n.mid AS mid, n.flds AS flds " +
      "FROM cards c JOIN notes n ON c.nid = n.id";
    const stmt = db.prepare(sql);
    const rows: RawCardNote[] = [];
    try {
      while (stmt.step()) {
        const r = stmt.getAsObject();
        rows.push({
          cid: Number(r.cid),
          nid: Number(r.nid),
          did: String(r.did),
          ord: Number(r.ord),
          mid: String(r.mid),
          flds: typeof r.flds === "string" ? r.flds : "",
          scheduling: {
            type: Number(r.ctype) || 0,
            queue: Number(r.queue) || 0,
            due: Number(r.due) || 0,
            ivl: Number(r.ivl) || 0,
            factor: Number(r.factor) || 0,
            reps: Number(r.reps) || 0,
            lapses: Number(r.lapses) || 0,
            data: typeof r.data === "string" ? r.data : "",
          },
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  private static splitFields(flds: string): string[] {
    return flds.split(FIELD_SEPARATOR);
  }

  private static mapFields(model: AnkiModel, values: string[]): Map<string, string> {
    const map = new Map<string, string>();
    model.flds.forEach((field, index) => {
      map.set(field.name, values[index] ?? "");
    });
    return map;
  }

  private static buildBasicCard(
    row: RawCardNote,
    model: AnkiModel,
    fieldMap: Map<string, string>,
    deckName: string,
    sanitize: SanitizeOptions
  ): AnkiParsedCard | null {
    const tmpl = model.tmpls.find((t) => t.ord === row.ord) ?? model.tmpls[0];
    if (!tmpl) return null;

    // Deterministically render the templates; field roles come from qfmt/afmt,
    // never from field names.
    const data: AnkiTemplateData = {};
    for (const field of model.flds) data[field.name] = fieldMap.get(field.name) ?? "";
    const rendered = AnkiTemplateEngine.render(tmpl.qfmt, tmpl.afmt, data);

    const media: string[] = [];
    const frontResult = AnkiSanitizer.sanitizeField(rendered.frontHtml, sanitize);
    for (const m of frontResult.media) media.push(m);
    // A markdown header must stay a single text line, so front-side media embeds
    // are separated; for a real front they relocate into the notes, for a
    // front-less card they become the table's front cell instead.
    const { text: headerText, embeds: frontEmbeds } = AnkiCollectionParser.splitEmbeds(frontResult.text);
    const header = AnkiCollectionParser.toHeader(headerText);

    const backResult = AnkiSanitizer.sanitizeField(rendered.answerHtml, sanitize);
    for (const m of backResult.media) media.push(m);
    const back = backResult.text.trim();

    // Fields the template never referenced become the notes (sanitized values).
    const extraLines: string[] = [];
    for (const extra of rendered.extraFields) {
      const result = AnkiSanitizer.sanitizeField(extra.value, sanitize);
      for (const m of result.media) media.push(m);
      if (result.text.trim()) extraLines.push(`**${extra.name}:** ${result.text.trim()}`);
    }

    // Layout escalation: default to header-paragraph; promote to an aggregated
    // table when the card is compact enough (single-paragraph back + notes), or
    // when there is no real front text (avoids an ugly `## Card <id>` header —
    // the front media becomes the front cell instead).
    let front: string;
    let notes: string;
    let tableLayout: boolean;
    if (header) {
      front = header;
      notes = [...extraLines, ...frontEmbeds].filter((p) => p.trim().length > 0).join("\n\n");
      tableLayout =
        AnkiCollectionParser.fitsTable(back) &&
        (!notes.trim() || AnkiCollectionParser.fitsTable(notes));
    } else {
      front = frontEmbeds.join("\n") || `Card ${row.nid}-${row.ord}`;
      notes = extraLines.filter((p) => p.trim().length > 0).join("\n\n");
      tableLayout = back.length > 0;
    }

    if (!back && !notes.trim() && front.startsWith("Card ")) return null;

    return {
      noteId: row.nid,
      cardId: row.cid,
      ord: row.ord,
      kind: "basic",
      isCloze: false,
      deckName,
      front,
      back,
      notes,
      tableLayout,
      media,
      scheduling: row.scheduling,
    };
  }

  // A back/notes value is "compact" enough for a table cell: a single short
  // paragraph with no block content. Long answers, multi-paragraph text, or block
  // math/code stay header-paragraph (a table cell flattens newlines to <br>).
  private static fitsTable(text: string): boolean {
    const t = text.trim();
    if (t.length === 0 || t.length > AnkiCollectionParser.MAX_TABLE_CHARS) return false;
    if (/\n[ \t]*\n/.test(t)) return false; // blank-line paragraph break
    if (t.split("\n").length > AnkiCollectionParser.MAX_TABLE_LINES) return false;
    if (hasBlockMarkdown(t)) return false; // tables/lists/$$/code can't live in a cell
    return true;
  }

  // Image-occlusion templates carry distinctive `io-*` element ids; the model
  // name also conventionally contains "occlusion".
  private static isImageOcclusion(model: AnkiModel): boolean {
    if (/occlusion/i.test(model.name)) return true;
    return model.tmpls.some((t) => /id=["']?io-/.test(t.qfmt) || /id=["']?io-/.test(t.afmt));
  }

  // --- Multi-field template cards ---

  // Multi-field notes become template-bound table rows. Columns are ordered by
  // how often each field is filled (so cells[0]/cells[1] are non-empty — the
  // Decks parser drops rows with an empty second cell). Each (model, ord) gets one
  // generated template file (markdown by default; HTML for CSS-layout models).
  private static buildTemplateCards(
    rows: RowContext[],
    sanitize: SanitizeOptions,
    templateFiles: Map<string, AnkiTemplateFile>
  ): AnkiParsedCard[] {
    if (rows.length === 0) return [];
    const byModel = new Map<string, RowContext[]>();
    for (const ctx of rows) {
      const group = byModel.get(ctx.model.id);
      if (group) group.push(ctx);
      else byModel.set(ctx.model.id, [ctx]);
    }

    // Only CSS-layout models reach here (see parse()); their HTML template renders
    // the layout, so cells keep their HTML.
    const cellSanitize: SanitizeOptions = { ...sanitize, keepHtml: true };
    const cards: AnkiParsedCard[] = [];
    for (const group of byModel.values()) {
      const model = group[0].model;
      const orderedFields = AnkiCollectionParser.fieldOrderByFill(model, group);
      for (const { row, deckName, fieldMap } of group) {
        const media: string[] = [];
        const cells = orderedFields.map((name) => {
          const result = AnkiSanitizer.sanitizeField(fieldMap.get(name) ?? "", cellSanitize);
          for (const m of result.media) media.push(m);
          return result.text;
        });
        // Need a non-empty front + second cell for the row to carry templateRow.
        if (!cells[0]?.trim() || !cells[1]?.trim()) continue;

        const tmpl = model.tmpls.find((t) => t.ord === row.ord) ?? model.tmpls[0];
        if (!tmpl) continue;
        const tag = AnkiTemplateExporter.tagFor(model, tmpl.ord ?? row.ord);
        if (!templateFiles.has(tag)) templateFiles.set(tag, AnkiTemplateExporter.build(model, tmpl));

        cards.push({
          noteId: row.nid,
          cardId: row.cid,
          ord: row.ord,
          kind: "template",
          isCloze: false,
          deckName,
          front: cells[0],
          back: cells[1],
          notes: "",
          templateRow: { headers: orderedFields, cells },
          templateTag: tag,
          media,
          scheduling: row.scheduling,
        });
      }
    }
    return cards;
  }

  // Keep Anki's field 0 first (its primary/sort field → the card front), then
  // order the rest by fill count (desc) so the second cell is rarely empty (the
  // Decks parser drops rows with an empty second cell).
  private static fieldOrderByFill(model: AnkiModel, group: RowContext[]): string[] {
    const names = model.flds.map((f) => f.name);
    if (names.length <= 1) return names;
    const counts = new Map<string, number>(names.map((n) => [n, 0]));
    for (const { fieldMap } of group) {
      for (const name of names) {
        if ((fieldMap.get(name) ?? "").trim()) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const rest = names
      .map((name, idx) => ({ name, idx }))
      .slice(1)
      .sort((a, b) => (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0) || a.idx - b.idx)
      .map((entry) => entry.name);
    return [names[0], ...rest];
  }

  // --- Image occlusion ---

  // Group IO notes by their shared base image and emit one occlusion card per
  // note (carrying all of the image's masks + this note's mask id). The renderer
  // collapses a group into a single `decks-occlusion` block.
  private static buildOcclusionCards(
    rows: RowContext[],
    getMediaText: ((filename: string) => string | undefined) | undefined
  ): AnkiParsedCard[] {
    if (rows.length === 0 || !getMediaText) return [];
    const byImage = new Map<string, RowContext[]>();
    for (const ctx of rows) {
      const image = AnkiCollectionParser.occlusionBaseImage(ctx);
      if (!image) continue;
      const group = byImage.get(image);
      if (group) group.push(ctx);
      else byImage.set(image, [ctx]);
    }

    const cards: AnkiParsedCard[] = [];
    for (const [image, group] of byImage) {
      const masks = AnkiCollectionParser.occlusionMasks(group, getMediaText);
      if (!masks || masks.length === 0) continue;
      const maskIds = new Set(masks.map((m) => m.id));
      group.forEach((ctx, i) => {
        const noteMaskId = AnkiCollectionParser.occlusionNoteMaskId(ctx);
        const maskId = noteMaskId && maskIds.has(noteMaskId) ? noteMaskId : masks[i % masks.length].id;
        cards.push({
          noteId: ctx.row.nid,
          cardId: ctx.row.cid,
          ord: ctx.row.ord,
          kind: "occlusion",
          isCloze: false,
          deckName: ctx.deckName,
          front: `![[${image}]]`,
          back: "",
          notes: "",
          imageRef: `[[${image}]]`,
          imagePath: image,
          masks,
          maskId,
          media: [image],
          scheduling: ctx.row.scheduling,
        });
      });
    }
    return cards;
  }

  // The non-SVG `<img src>` across the note's fields (the base picture).
  private static occlusionBaseImage(ctx: RowContext): string | null {
    for (const value of ctx.fieldMap.values()) {
      for (const src of AnkiCollectionParser.imgSrcs(value)) {
        if (!/\.svg$/i.test(src)) return src;
      }
    }
    return null;
  }

  // This note's mask id — its `…-oa-N` field value (the SVG rect id).
  private static occlusionNoteMaskId(ctx: RowContext): string | null {
    for (const value of ctx.fieldMap.values()) {
      const trimmed = value.trim();
      if (/-oa-\d+$/.test(trimmed)) return trimmed;
    }
    return null;
  }

  // Extract masks from the group's Original Mask SVG (`…-oa-O.svg`), falling back
  // to the union of per-note Question Mask SVGs.
  private static occlusionMasks(
    group: RowContext[],
    getMediaText: (filename: string) => string | undefined
  ): OcclusionMask[] | null {
    for (const ctx of group) {
      for (const value of ctx.fieldMap.values()) {
        const match = /-oa-O\.svg/i.exec(value);
        if (!match) continue;
        const svgName = AnkiCollectionParser.imgSrcs(value).find((s) => /-oa-O\.svg$/i.test(s));
        const svg = svgName ? getMediaText(svgName) : undefined;
        const extracted = svg ? AnkiOcclusionExtractor.extract(svg) : null;
        if (extracted) return extracted.masks;
      }
    }
    // Fallback: union each note's Question Mask rects (deduped by id).
    const masks: OcclusionMask[] = [];
    const seen = new Set<string>();
    for (const ctx of group) {
      for (const value of ctx.fieldMap.values()) {
        const svgName = AnkiCollectionParser.imgSrcs(value).find((s) => /-Q\.svg$/i.test(s));
        const svg = svgName ? getMediaText(svgName) : undefined;
        const extracted = svg ? AnkiOcclusionExtractor.extract(svg) : null;
        if (!extracted) continue;
        for (const mask of extracted.masks) {
          if (seen.has(mask.id)) continue;
          seen.add(mask.id);
          masks.push(mask);
        }
      }
    }
    return masks.length > 0 ? masks : null;
  }

  private static imgSrcs(value: string): string[] {
    // Captures the full src (quoted values may contain spaces); a whitespace-
    // truncating capture loses filenames with spaces.
    const result: string[] = [];
    const regex = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (raw) result.push(AnkiSanitizer.decodeSrc(raw));
    }
    return result;
  }

  private static buildClozeCard(
    row: RawCardNote,
    model: AnkiModel,
    fieldMap: Map<string, string>,
    deckName: string,
    sanitize: SanitizeOptions,
    templateFiles: Map<string, AnkiTemplateFile>
  ): AnkiParsedCard | null {
    const fieldNames = new Set(model.flds.map((f) => f.name));
    const clozeFieldName = AnkiCollectionParser.findClozeField(model, fieldNames);
    if (!clozeFieldName) return null;

    const media: string[] = [];
    const bodyResult = AnkiSanitizer.sanitizeField(fieldMap.get(clozeFieldName) ?? "", sanitize);
    for (const m of bodyResult.media) media.push(m);
    const clozeBody = bodyResult.text;

    // Extra (non-cloze, non-id) fields → a bound template's notes face (the
    // Notes button). Sanitized to markdown so media/embeds resolve.
    const extraFields = model.flds
      .map((f) => f.name)
      .filter((name) => name !== clozeFieldName && !ID_FIELD.test(name));
    const extraValues = extraFields.map((name) => {
      const result = AnkiSanitizer.sanitizeField(fieldMap.get(name) ?? "", sanitize);
      for (const m of result.media) media.push(m);
      return result.text;
    });
    const hasExtras = extraValues.some((v) => v.trim().length > 0);

    const answers = AnkiCollectionParser.highlightAnswers(clozeBody);
    const card: AnkiParsedCard = {
      noteId: row.nid,
      cardId: row.cid,
      ord: row.ord,
      kind: "cloze",
      isCloze: true,
      deckName,
      front: clozeBody, // the cloze sentence drives the card id
      back: clozeBody,
      notes: extraValues.filter((v) => v.trim()).join("\n\n"),
      clozeBody,
      clozeText: answers[row.ord],
      clozeOrder: row.ord,
      media,
      scheduling: row.scheduling,
    };

    if (hasExtras) {
      // A tag-bound markdown template renders the cloze (front) + extras (notes).
      const tag = AnkiTemplateExporter.clozeTagFor(model);
      card.templateRow = { headers: [clozeFieldName, ...extraFields], cells: [clozeBody, ...extraValues] };
      card.templateTag = tag;
      if (!templateFiles.has(tag)) {
        templateFiles.set(tag, AnkiTemplateExporter.buildCloze(model, clozeFieldName, extraFields));
      }
    }

    return card;
  }

  private static findClozeField(model: AnkiModel, fieldNames: Set<string>): string | null {
    const regex = /\{\{cloze:([^}]+)\}\}/;
    for (const tmpl of model.tmpls) {
      const match = regex.exec(tmpl.qfmt) ?? regex.exec(tmpl.afmt);
      if (match) {
        const name = match[1].trim();
        if (fieldNames.has(name)) return name;
      }
    }
    // Fallback: the first field (cloze models put the text in field 0).
    return model.flds[0]?.name ?? null;
  }

  // Inner text of each ==highlight== in document order (matches Decks' parser).
  private static highlightAnswers(clozeBody: string): string[] {
    const regex = /==((?:(?!==).)+)==/g;
    const answers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clozeBody)) !== null) answers.push(match[1].trim());
    return answers;
  }

  // A markdown header must be a single line; collapse newlines so multi-field
  // prompts stay on one `## …` line.
  private static toHeader(text: string): string {
    return text.replace(/\s*\n+\s*/g, " ").trim();
  }

  // Separate ![[…]] embeds from surrounding text so they can be kept out of a header.
  private static splitEmbeds(text: string): { text: string; embeds: string[] } {
    const embeds: string[] = [];
    const stripped = text.replace(/!\[\[[^\]]+\]\]/g, (embed) => {
      embeds.push(embed);
      return "";
    });
    return { text: stripped, embeds };
  }

  private static isNew(scheduling: AnkiScheduling): boolean {
    return scheduling.type === 0 && scheduling.queue <= 0 && scheduling.ivl === 0 && scheduling.reps === 0;
  }

  /** Collection creation time in ms — `col.crt` is stored in seconds. */
  static readCollectionCreatedMs(db: RawDatabase): number | undefined {
    const stmt = db.prepare("SELECT crt AS crt FROM col LIMIT 1");
    try {
      if (!stmt.step()) return undefined;
      const crt = Number(stmt.getAsObject().crt);
      return Number.isFinite(crt) && crt > 0 ? crt * 1000 : undefined;
    } finally {
      stmt.free();
    }
  }

  /** Real Anki review rows grouped by card id, for the review timeline. */
  static readRevlog(db: RawDatabase): Map<number, AnkiRevlogRow[]> {
    const result = new Map<number, AnkiRevlogRow[]>();
    const stmt = db.prepare(
      "SELECT id, cid, ease, ivl, lastIvl, factor FROM revlog ORDER BY id ASC"
    );
    try {
      while (stmt.step()) {
        const r = stmt.getAsObject();
        const row: AnkiRevlogRow = {
          id: Number(r.id),
          cid: Number(r.cid),
          ease: Number(r.ease) || 0,
          ivl: Number(r.ivl) || 0,
          lastIvl: Number(r.lastIvl) || 0,
          factor: Number(r.factor) || 0,
        };
        const group = result.get(row.cid);
        if (group) group.push(row);
        else result.set(row.cid, [row]);
      }
    } catch {
      // revlog may be absent in stripped exports — treat as no history.
      return result;
    } finally {
      stmt.free();
    }
    return result;
  }
}

interface RawCardNote {
  cid: number;
  nid: number;
  did: string;
  ord: number;
  mid: string;
  flds: string;
  scheduling: AnkiScheduling;
}
