import type { RawDatabase } from "../../FlashcardSynchronizer";
import { AnkiSanitizer } from "./AnkiSanitizer";
import type { AnkiRevlogRow } from "./AnkiHistoryImporter";
import type {
  AnkiDeckMeta,
  AnkiModel,
  AnkiParseResult,
  AnkiParsedCard,
  AnkiScheduling,
  AnkiTemplate,
} from "./AnkiTypes";

// Anki joins a note's field values with the unit separator.
const FIELD_SEPARATOR = "\x1f";

// Template tokens that are not user fields and must be ignored during field-role
// resolution.
const SPECIAL_TOKENS = new Set([
  "FrontSide",
  "Tags",
  "Type",
  "Deck",
  "Subdeck",
  "Card",
  "CardFlag",
]);

// Field-name match for picking a readable header on cloze notes.
const CLOZE_HEADER_FIELD = /trans|back|mean|english|answer|definition|hint/i;
// Field names that are bookkeeping ids, never used as content.
const ID_FIELD = /^(id|guid|uid|key)$/i;

export interface AnkiParseOptions {
  hintLabel?: string;
}

/**
 * Reads an Anki collection (sql.js `Database` satisfies {@link RawDatabase}) and
 * produces normalized {@link AnkiParsedCard}s. Pure logic — the plugin handles
 * unzipping and instantiating the database.
 */
export class AnkiCollectionParser {
  static parse(db: RawDatabase, options: AnkiParseOptions = {}): AnkiParseResult {
    const hintLabel = options.hintLabel ?? "hint";
    const models = AnkiCollectionParser.readModels(db);
    const decks = AnkiCollectionParser.readDecks(db);

    const cards: AnkiParsedCard[] = [];
    const noteIds = new Set<number>();
    const mediaFiles = new Set<string>();
    let withHistory = 0;

    const rows = AnkiCollectionParser.readCardNoteRows(db);
    for (const row of rows) {
      const model = models.get(row.mid);
      if (!model) continue;
      const deckName = decks.get(row.did) ?? "Default";
      const fieldValues = AnkiCollectionParser.splitFields(row.flds);
      const fieldMap = AnkiCollectionParser.mapFields(model, fieldValues);

      const parsed =
        model.type === 1
          ? AnkiCollectionParser.buildClozeCard(row, model, fieldMap, deckName, hintLabel)
          : AnkiCollectionParser.buildBasicCard(row, model, fieldMap, deckName, hintLabel);
      if (!parsed) continue;

      noteIds.add(row.nid);
      for (const m of parsed.media) mediaFiles.add(m);
      if (!AnkiCollectionParser.isNew(parsed.scheduling)) withHistory++;
      cards.push(parsed);
    }

    const deckNames = Array.from(new Set(cards.map((c) => c.deckName))).sort();
    return {
      cards,
      deckNames,
      noteCount: noteIds.size,
      cardCount: cards.length,
      withHistory,
      mediaFiles: Array.from(mediaFiles).sort(),
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
    return result;
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
    return { id, name: String(obj.name ?? ""), type: typeof obj.type === "number" ? obj.type : 0, flds, tmpls };
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

  // --- Field-role resolution ---

  // Ordered, de-duplicated field names referenced by a template, ignoring
  // conditionals, special tokens, and field modifiers (`text:`, `hint:`, …).
  private static referencedFields(template: string, fieldNames: Set<string>): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const regex = /\{\{([^}]+)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(template)) !== null) {
      let token = match[1].trim();
      token = token.replace(/^[#^/]/, "").trim(); // strip conditional markers
      if (token.includes(":")) token = token.slice(token.lastIndexOf(":") + 1).trim();
      if (!token || SPECIAL_TOKENS.has(token)) continue;
      if (!fieldNames.has(token) || seen.has(token)) continue;
      seen.add(token);
      result.push(token);
    }
    return result;
  }

  private static buildBasicCard(
    row: RawCardNote,
    model: AnkiModel,
    fieldMap: Map<string, string>,
    deckName: string,
    hintLabel: string
  ): AnkiParsedCard | null {
    const tmpl = model.tmpls.find((t) => t.ord === row.ord) ?? model.tmpls[0];
    if (!tmpl) return null;
    const fieldNames = new Set(model.flds.map((f) => f.name));

    const promptFields = AnkiCollectionParser.referencedFields(tmpl.qfmt, fieldNames);
    const answerFields = AnkiCollectionParser.referencedFields(tmpl.afmt, fieldNames).filter(
      (name) => !promptFields.includes(name)
    );

    const media: string[] = [];
    const promptText = AnkiCollectionParser.joinFields(
      promptFields.length ? promptFields : [model.flds[0]?.name ?? ""],
      fieldMap,
      hintLabel,
      media
    );
    const answerSource =
      answerFields.length > 0
        ? answerFields
        : model.flds.map((f) => f.name).filter((name) => !promptFields.includes(name));
    const answer = AnkiCollectionParser.joinFields(answerSource, fieldMap, hintLabel, media);

    // A markdown header must stay a single text line, so front-side media embeds
    // are relocated into the body rather than the `## …` heading.
    const { text: headerText, embeds: frontEmbeds } = AnkiCollectionParser.splitEmbeds(promptText);
    const headerFront = AnkiCollectionParser.toHeader(headerText) || `Card ${row.nid}-${row.ord}`;
    const back = [answer, ...frontEmbeds].filter((part) => part.trim().length > 0).join("\n\n");

    if (!back.trim() && headerFront.startsWith("Card ")) return null;

    return {
      noteId: row.nid,
      cardId: row.cid,
      ord: row.ord,
      isCloze: false,
      deckName,
      front: headerFront,
      back,
      media,
      scheduling: row.scheduling,
    };
  }

  private static buildClozeCard(
    row: RawCardNote,
    model: AnkiModel,
    fieldMap: Map<string, string>,
    deckName: string,
    hintLabel: string
  ): AnkiParsedCard | null {
    const fieldNames = new Set(model.flds.map((f) => f.name));
    const clozeFieldName = AnkiCollectionParser.findClozeField(model, fieldNames);
    if (!clozeFieldName) return null;

    const media: string[] = [];
    const bodyResult = AnkiSanitizer.sanitizeField(fieldMap.get(clozeFieldName) ?? "", hintLabel);
    for (const m of bodyResult.media) media.push(m);
    const clozeBody = bodyResult.text;

    // Extra answer-side fields (translation, image, audio) appended below the body.
    const extras = model.flds
      .map((f) => f.name)
      .filter((name) => name !== clozeFieldName && !ID_FIELD.test(name));
    const extraText = AnkiCollectionParser.joinFields(extras, fieldMap, hintLabel, media);

    const header = AnkiCollectionParser.clozeHeader(model, fieldMap, hintLabel) || `Cloze ${row.nid}`;
    const answers = AnkiCollectionParser.highlightAnswers(clozeBody);
    const back = extraText.trim() ? `${clozeBody}\n\n${extraText}` : clozeBody;

    return {
      noteId: row.nid,
      cardId: row.cid,
      ord: row.ord,
      isCloze: true,
      deckName,
      front: header,
      back,
      clozeBody,
      clozeText: answers[row.ord],
      clozeOrder: row.ord,
      media,
      scheduling: row.scheduling,
    };
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

  private static clozeHeader(
    model: AnkiModel,
    fieldMap: Map<string, string>,
    hintLabel: string
  ): string {
    const named = model.flds.find((f) => CLOZE_HEADER_FIELD.test(f.name));
    const value = named ? fieldMap.get(named.name) ?? "" : "";
    const { text } = AnkiCollectionParser.splitEmbeds(AnkiSanitizer.sanitizeField(value, hintLabel).text);
    return AnkiCollectionParser.toHeader(text);
  }

  // Inner text of each ==highlight== in document order (matches Decks' parser).
  private static highlightAnswers(clozeBody: string): string[] {
    const regex = /==((?:(?!==).)+)==/g;
    const answers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clozeBody)) !== null) answers.push(match[1].trim());
    return answers;
  }

  private static joinFields(
    names: string[],
    fieldMap: Map<string, string>,
    hintLabel: string,
    media: string[]
  ): string {
    const parts: string[] = [];
    for (const name of names) {
      const raw = fieldMap.get(name);
      if (!raw) continue;
      const result = AnkiSanitizer.sanitizeField(raw, hintLabel);
      for (const m of result.media) media.push(m);
      if (result.text.trim()) parts.push(result.text.trim());
    }
    return parts.join("\n\n");
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
