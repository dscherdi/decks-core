import { FlashcardParser } from "./FlashcardParser";
import { CanvasFlashcardExtractor } from "./CanvasFlashcardExtractor";
import type { Flashcard, FlashcardType, DeckProfile, TemplateRow } from "../database/types";
import { parseHeaderLevels } from "../database/types";
import type { SqlJsValue } from "../database/sql-types";
import {
  generateFlashcardId,
  generateContentHash,
  generateReverseFlashcardId,
  generateClozeFlashcardId,
  generateSpatialFlashcardId,
  generateSpatialClozeFlashcardId,
  generateOcclusionV2FlashcardId,
} from "../utils/hash";
import { occlusionV2HashInput, occlusionImageName } from "./occlusion/OcclusionV2";
import { cardIdForKey, isIdKey, reverseBindingKey } from "../utils/anchors";

export interface FlashcardUpdates {
  front: string;
  back: string;
  notes: string;
  type: string;
  contentHash: string;
  breadcrumb: string;
  tags: string[];
  hint: string;
  clozeText: string | null;
  clozeOrder: number | null;
  templateRow: TemplateRow | null;
  anchor: string | null;
}

function serializeTemplateRow(row: TemplateRow | null | undefined): string | null {
  return row ? JSON.stringify(row) : null;
}

function serializeTagsForSql(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  return tags.filter((t) => t.length > 0).join(",");
}

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

export interface BatchOperation {
  type: "create" | "update" | "delete" | "migrate" | "bind" | "anchor";
  flashcardId?: string;
  // "anchor" only: the token moved or changed form; nothing a reviewer sees changed.
  anchor?: string | null;
  flashcard?: Omit<Flashcard, "created" | "modified">;
  updates?: FlashcardUpdates;
  oldId?: string;
  newId?: string;
  // Durable anchor->id binding to record with this op (adopt case only —
  // written when the card provably owns the anchor's history).
  bindAnchor?: { anchor: string; flashcardId: string };
}

export interface SyncResult {
  success: boolean;
  parsedCount: number;
  operationsCount: number;
  duplicatesSkipped: number;
  // Set when the file parsed to zero cards while the deck still had cards: the
  // sync is aborted (cards preserved) rather than deleting everything. Callers
  // must NOT stamp last_synced_mtime for a skipped sync.
  skippedEmptyParse?: boolean;
  // Different cards whose content hashed to the same id; the later one was left out.
  idCollisions?: Array<{ id: string; fronts: [string, string] }>;
}

/**
 * Whether a sync would empty a deck that still has cards, and should therefore
 * be refused.
 *
 * `refuseEmptyResult` is the caller's, because only the caller can tell the two
 * cases apart. A note whose cards were cut out and pasted into another note
 * parses to nothing and *should* empty — that is how a deck moves, and its
 * history follows. A note nobody touched that suddenly parses to nothing is a
 * header level that stopped matching, and emptying it loses the deck.
 *
 * From in here the two are identical: heading present, no cards. What separates
 * them is whether the file changed since the last sync, which the caller knows
 * and this does not.
 */
export function wouldEmptyDeck(
  parsedCount: number,
  existingCount: number,
  reasons: { contentEmpty: boolean; refuseEmptyResult?: boolean },
): boolean {
  if (parsedCount !== 0 || existingCount === 0) return false;
  // An empty read is always a race, never an edit: a live deck file has at
  // least its frontmatter tag. That protection is unconditional.
  if (reasons.contentEmpty) return true;
  return reasons.refuseEmptyResult === true;
}

export interface SyncData {
  deckId: string;
  deckName: string;
  deckFilepath: string;
  deckConfig: DeckProfile;
  fileContent: string;
  fileTitle?: string;
  reverseCards?: boolean;
  clozeEnabled?: boolean;
  examEnabled?: boolean;
  /**
   * Refuse to let a parse that yields nothing delete the deck's remaining
   * cards. Set it only when the caller knows the note has not changed since the
   * last sync — an empty parse over unchanged content is a configuration fault,
   * never an edit. Left unset, an empty parse empties the deck as it always has,
   * which is what a deck being moved out of a note depends on.
   */
  refuseEmptyResult?: boolean;
}

/**
 * Minimal interface for a raw SQLite database handle.
 * Structurally satisfied by sql.js Database and expo-sqlite adapters.
 */
export interface RawDatabase {
  prepare(sql: string): RawStatement;
  run(sql: string, params?: SqlJsValue[]): void;
}

export interface RawStatement {
  bind(params: SqlJsValue[]): boolean;
  step(): boolean;
  get(): SqlJsValue[];
  getAsObject(params?: Record<string, SqlJsValue>): Record<string, SqlJsValue>;
  run(params?: SqlJsValue[]): void;
  free(): void;
}

export class FlashcardSynchronizer {
  constructor(private db: RawDatabase) {}

  // Durable suspend/bury state for a card id; falls back to clear state on
  // databases that predate the card_state_overlays table.
  private overlayState(flashcardId: string): {
    suspendedAt: string | null;
    buriedUntil: string | null;
  } {
    try {
      const stmt = this.db.prepare(
        "SELECT suspended_at, buried_until FROM card_state_overlays WHERE flashcard_id = ?"
      );
      stmt.bind([flashcardId]);
      const row = stmt.step() ? stmt.get() : null;
      stmt.free();
      return {
        suspendedAt: (row?.[0] as string) ?? null,
        buriedUntil: (row?.[1] as string) ?? null,
      };
    } catch {
      return { suspendedAt: null, buriedUntil: null };
    }
  }

  // Re-point an overlay row when a card's id migrates, keeping the newer
  // record if the target id already has one.
  private repointOverlay(oldId: string, newId: string): void {
    try {
      const copyStmt = this.db.prepare(`
        INSERT INTO card_state_overlays (flashcard_id, suspended_at, buried_until, modified)
        SELECT ?, suspended_at, buried_until, modified FROM card_state_overlays WHERE flashcard_id = ?
        ON CONFLICT(flashcard_id) DO UPDATE SET
          suspended_at = excluded.suspended_at,
          buried_until = excluded.buried_until,
          modified = excluded.modified
        WHERE excluded.modified > card_state_overlays.modified
      `);
      copyStmt.run([newId, oldId]);
      copyStmt.free();
      const deleteStmt = this.db.prepare(
        "DELETE FROM card_state_overlays WHERE flashcard_id = ?"
      );
      deleteStmt.run([oldId]);
      deleteStmt.free();
    } catch {
      // Table absent on databases that predate it.
    }
  }

  // A card the AI workbench wrote keeps its source page when an edit re-keys it.
  private repointAiOrigin(oldId: string, newId: string): void {
    try {
      const stmt = this.db.prepare(
        "UPDATE ai_staged_cards SET dedup_hash = ?, modified = ? WHERE dedup_hash = ?"
      );
      stmt.run([newId, new Date().toISOString(), oldId]);
      stmt.free();
    } catch {
      // Table absent on databases that predate it.
    }
  }

  private columnsCache: string[] | null = null;

  private flashcardColumns(): string[] {
    if (this.columnsCache) return this.columnsCache;
    const stmt = this.db.prepare("PRAGMA table_info(flashcards)");
    const columns: string[] = [];
    while (stmt.step()) columns.push(stmt.getAsObject().name as string);
    stmt.free();
    this.columnsCache = columns;
    return columns;
  }

  // Every row keyed by card id follows the card when its id changes.
  private repointChildren(oldId: string, newId: string): void {
    const run = (sql: string): void => {
      try {
        const stmt = this.db.prepare(sql);
        stmt.run([newId, oldId]);
        stmt.free();
      } catch {
        // Table absent on databases that predate it.
      }
    };
    run("UPDATE review_logs SET flashcard_id = ? WHERE flashcard_id = ?");
    run("UPDATE exam_answers SET flashcard_id = ? WHERE flashcard_id = ?");
    run("UPDATE OR IGNORE custom_deck_cards SET flashcard_id = ? WHERE flashcard_id = ?");
    run("UPDATE OR IGNORE custom_deck_card_tombstones SET flashcard_id = ? WHERE flashcard_id = ?");
    try {
      const leftover = this.db.prepare("DELETE FROM custom_deck_cards WHERE flashcard_id = ?");
      leftover.run([oldId]);
      leftover.free();
    } catch {
      // Table absent on databases that predate it.
    }
    this.repointOverlay(oldId, newId);
    this.repointAiOrigin(oldId, newId);
  }

  // The scheduling state the newest review log under `id` implies, if any.
  private newestLogState(id: string): {
    state: "new" | "review";
    intervalMinutes: number;
    repetitions: number;
    difficulty: number;
    stability: number;
    lapses: number;
    reviewedAt: string;
  } | null {
    const stmt = this.db.prepare(`
      SELECT new_state, new_interval_minutes, new_repetitions, new_difficulty,
             new_stability, new_lapses, reviewed_at
      FROM review_logs WHERE flashcard_id = ? ORDER BY reviewed_at DESC LIMIT 1
    `);
    stmt.bind([id]);
    const row = stmt.step() ? stmt.get() : null;
    stmt.free();
    if (!row) return null;
    return {
      state: row[0] as "new" | "review",
      intervalMinutes: row[1] as number,
      repetitions: row[2] as number,
      difficulty: row[3] as number,
      stability: row[4] as number,
      lapses: row[5] as number,
      reviewedAt: row[6] as string,
    };
  }

  // After a merge, a review newer than the surviving row's last one wins.
  private applyNewerLogState(id: string): void {
    const log = this.newestLogState(id);
    if (!log) return;
    const current = this.db.prepare("SELECT last_reviewed FROM flashcards WHERE id = ?");
    current.bind([id]);
    const lastReviewed = current.step() ? (current.get()[0] as string | null) : null;
    current.free();
    if (lastReviewed !== null && lastReviewed >= log.reviewedAt) return;
    const dueDate = new Date(
      new Date(log.reviewedAt).getTime() + log.intervalMinutes * 60 * 1000
    ).toISOString();
    const update = this.db.prepare(`
      UPDATE flashcards SET state = ?, due_date = ?, interval = ?, repetitions = ?,
             difficulty = ?, stability = ?, lapses = ?, last_reviewed = ?
      WHERE id = ?
    `);
    update.run([
      log.state, dueDate, log.intervalMinutes, log.repetitions,
      log.difficulty, log.stability, log.lapses, log.reviewedAt, id,
    ]);
    update.free();
  }

  // Binding rows for exactly the keys a note carries, not the whole table.
  private loadBindings(keys: string[]): Map<string, string> {
    const bindings = new Map<string, string>();
    const unique = Array.from(new Set(keys));
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400);
      const stmt = this.db.prepare(
        `SELECT anchor, flashcard_id FROM anchor_bindings WHERE anchor IN (${chunk.map(() => "?").join(",")})`
      );
      stmt.bind(chunk);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        bindings.set(row.anchor as string, row.flashcard_id as string);
      }
      stmt.free();
    }
    return bindings;
  }

  /**
   * Execute batch database operations using raw SQL
   */
  executeBatchOperations(operations: BatchOperation[]): void {
    for (const op of operations) {
      if (op.bindAnchor) {
        const bindStmt = this.db.prepare(
          "INSERT OR IGNORE INTO anchor_bindings (anchor, flashcard_id, created) VALUES (?, ?, datetime('now'))"
        );
        bindStmt.run([op.bindAnchor.anchor, op.bindAnchor.flashcardId]);
        bindStmt.free();
      }
      if (op.type === "migrate" && op.oldId && op.flashcard) {
        // Safety check: if target ID already exists (hash collision), just delete the old card
        const card = op.flashcard;
        const checkStmt = this.db.prepare("SELECT id FROM flashcards WHERE id = ?");
        checkStmt.bind([card.id]);
        const targetExists = checkStmt.step();
        checkStmt.free();
        if (targetExists) {
          // Both rows are the same card: fold the old one in, keeping its history.
          this.repointChildren(op.oldId, card.id);
          const deleteStmt = this.db.prepare("DELETE FROM flashcards WHERE id = ?");
          deleteStmt.run([op.oldId]);
          deleteStmt.free();
          this.applyNewerLogState(card.id);
          continue;
        }

        // Copy the row under its new id before moving children, so no foreign key
        // ever points at a missing card, then refresh its content.
        const columns = this.flashcardColumns();
        const copyStmt = this.db.prepare(
          `INSERT INTO flashcards (${columns.join(", ")}) SELECT ${columns
            .map((column) => (column === "id" ? "?" : column))
            .join(", ")} FROM flashcards WHERE id = ?`
        );
        copyStmt.run([card.id, op.oldId]);
        copyStmt.free();
        this.repointChildren(op.oldId, card.id);
        const dropStmt = this.db.prepare("DELETE FROM flashcards WHERE id = ?");
        dropStmt.run([op.oldId]);
        dropStmt.free();

        const updateStmt = this.db.prepare(`
                    UPDATE flashcards
                    SET front = ?, back = ?, content_hash = ?, breadcrumb = ?, notes = ?,
                        type = ?, cloze_text = ?, cloze_order = ?, source_node_id = ?, edge_id = ?,
                        hint = ?, tags = ?, template_row = ?, anchor = ?, modified = datetime('now')
                    WHERE id = ?
                `);
        updateStmt.run([
          card.front,
          card.back,
          card.contentHash,
          card.breadcrumb || "",
          card.notes || "",
          card.type,
          card.clozeText ?? null,
          card.clozeOrder ?? null,
          card.sourceNodeId ?? null,
          card.edgeId ?? null,
          card.hint || "",
          serializeTagsForSql(card.tags),
          serializeTemplateRow(card.templateRow),
          card.anchor ?? null,
          card.id,
        ]);
        updateStmt.free();

        // Reviews another device logged under the new id may be newer than this row.
        this.applyNewerLogState(card.id);
      } else if (op.type === "anchor" && op.flashcardId) {
        const stmt = this.db.prepare("UPDATE flashcards SET anchor = ? WHERE id = ?");
        stmt.run([op.anchor ?? null, op.flashcardId]);
        stmt.free();
      } else if (op.type === "delete" && op.flashcardId) {
        const stmt = this.db.prepare("DELETE FROM flashcards WHERE id = ?");
        stmt.run([op.flashcardId]);
        stmt.free();
      } else if (op.type === "create" && op.flashcard) {
        const card = op.flashcard;
        // Card ids are deck-independent, so a card can already exist under a
        // different deck (moved note) or be orphaned (its old deck row is gone).
        // Upsert instead of INSERT OR IGNORE. A genuinely-new card takes the plain
        // INSERT (review_logs restoration). On id conflict we ADOPT the row into
        // this deck (move deck_id + refresh content, preserving scheduling/suspend/
        // bury/created) — but ONLY when its current deck is DEAD (orphaned), i.e.
        // leftovers from an old import. The `WHERE … deck is null` makes the whole
        // update a no-op when the card still lives in a LIVE deck, so a front shared
        // by two overlapping decks stays put instead of bouncing/being overwritten.
        const stmt = this.db.prepare(`
                    INSERT INTO flashcards (
                        id, deck_id, front, back, type, source_file, content_hash, breadcrumb, notes,
                        cloze_text, cloze_order, source_node_id, edge_id, hint,
                        state, due_date, interval, repetitions, difficulty, stability,
                        lapses, last_reviewed, created, modified, tags,
                        suspended_at, buried_until, template_row, anchor
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        deck_id = excluded.deck_id,
                        front = excluded.front,
                        back = excluded.back,
                        type = excluded.type,
                        source_file = excluded.source_file,
                        content_hash = excluded.content_hash,
                        breadcrumb = excluded.breadcrumb,
                        notes = excluded.notes,
                        cloze_text = excluded.cloze_text,
                        cloze_order = excluded.cloze_order,
                        source_node_id = excluded.source_node_id,
                        edge_id = excluded.edge_id,
                        hint = excluded.hint,
                        tags = excluded.tags,
                        template_row = excluded.template_row,
                        anchor = excluded.anchor,
                        modified = datetime('now')
                    WHERE (SELECT 1 FROM decks d WHERE d.id = flashcards.deck_id) IS NULL
                `);
        stmt.run([
          card.id,
          card.deckId,
          card.front,
          card.back,
          card.type,
          card.sourceFile,
          card.contentHash,
          card.breadcrumb || "",
          card.notes || "",
          card.clozeText,
          card.clozeOrder,
          card.sourceNodeId ?? null,
          card.edgeId ?? null,
          card.hint || "",
          card.state,
          card.dueDate,
          card.interval,
          card.repetitions,
          card.difficulty,
          card.stability,
          card.lapses,
          card.lastReviewed,
          serializeTagsForSql(card.tags),
          card.suspendedAt ?? null,
          card.buriedUntil ?? null,
          serializeTemplateRow(card.templateRow),
          card.anchor ?? null,
        ]);
        stmt.free();
      } else if (op.type === "update" && op.flashcardId && op.updates) {
        const stmt = this.db.prepare(`
                    UPDATE flashcards
                    SET front = ?, back = ?, type = ?, content_hash = ?, breadcrumb = ?, notes = ?,
                        cloze_text = ?, cloze_order = ?, hint = ?, tags = ?, template_row = ?,
                        anchor = ?, modified = datetime('now')
                    WHERE id = ?
                `);
        stmt.run([
          op.updates.front,
          op.updates.back,
          op.updates.type,
          op.updates.contentHash,
          op.updates.breadcrumb || "",
          op.updates.notes || "",
          op.updates.clozeText,
          op.updates.clozeOrder,
          op.updates.hint || "",
          serializeTagsForSql(op.updates.tags),
          serializeTemplateRow(op.updates.templateRow),
          op.updates.anchor,
          op.flashcardId,
        ]);
        stmt.free();
      }
    }
  }

  /**
   * Sync flashcards for a deck
   */
  syncFlashcardsForDeck(
    data: SyncData,
    progressCallback?: (progress: number, message?: string) => void
  ): SyncResult {
    try {
      // Parse flashcards from content. Canvas files have a different on-disk
      // shape (JSON wrapping markdown text nodes) — branch by extension and
      // let CanvasFlashcardExtractor stamp each parsed card with its source
      // text-node id.
      progressCallback?.(10, "Parsing flashcards from file content...");
      const isCanvas = data.deckFilepath.toLowerCase().endsWith(".canvas");
      const headerLevels = parseHeaderLevels(data.deckConfig);
      const parsedCards = isCanvas
        ? CanvasFlashcardExtractor.extract(
            data.fileContent,
            headerLevels,
            data.fileTitle,
            data.clozeEnabled,
          )
        : FlashcardParser.parseFlashcardsFromContent(
            data.fileContent,
            headerLevels,
            data.fileTitle,
            data.clozeEnabled,
            data.examEnabled,
          );

      // Expand with reverse cards if enabled. Cloze, image-occlusion, spatial
      // and multiple-choice cards never reverse — spatial edges are
      // directional, and flipping the other formats (options as a front, a
      // deleted word as a question) makes no sensible card.
      const expandedCards = [...parsedCards];
      if (data.reverseCards) {
        for (const card of parsedCards) {
          if (
            card.back &&
            card.type !== "cloze" &&
            card.type !== "image-occlusion" &&
            card.type !== "image-occlusion-v2" &&
            card.type !== "spatial" &&
            card.type !== "multiple-choice" &&
            !card.edgeId
          ) {
            expandedCards.push({
              front: card.back,
              back: card.front,
              notes: card.notes,
              type: card.type,
              breadcrumb: card.breadcrumb,
              tags: [...card.tags],
              isReverse: true,
              sourceNodeId: card.sourceNodeId,
              ...(card.anchorKey
                ? { anchorKey: reverseBindingKey(card.anchorKey) }
                : {}),
            });
          }
        }
      }

      // Get existing flashcards
      progressCallback?.(20, "Loading existing flashcards...");
      const existingFlashcards: Flashcard[] = [];
      const stmt = this.db.prepare(
        "SELECT * FROM flashcards WHERE deck_id = ?"
      );
      stmt.bind([data.deckId]);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const tagsRaw = (row.tags as string) || "";
        const tags = tagsRaw === "" ? [] : tagsRaw.split(",").filter((t) => t.length > 0);
        existingFlashcards.push({
          id: row.id as string,
          deckId: row.deck_id as string,
          front: row.front as string,
          back: row.back as string,
          type: row.type as FlashcardType,
          sourceFile: row.source_file as string,
          contentHash: row.content_hash as string,
          breadcrumb: (row.breadcrumb as string) || "",
          notes: (row.notes as string) || "",
          hint: (row.hint as string) || "",
          clozeText: (row.cloze_text as string) ?? null,
          clozeOrder: (row.cloze_order as number) ?? null,
          sourceNodeId: (row.source_node_id as string) ?? null,
          edgeId: (row.edge_id as string) ?? null,
          templateRow: row.template_row
            ? (JSON.parse(row.template_row as string) as TemplateRow)
            : null,
          state: row.state as "new" | "review",
          dueDate: row.due_date as string,
          interval: row.interval as number,
          repetitions: row.repetitions as number,
          difficulty: row.difficulty as number,
          stability: row.stability as number,
          lapses: row.lapses as number,
          lastReviewed: row.last_reviewed as string | null,
          created: row.created as string,
          modified: row.modified as string,
          tags,
          suspendedAt: (row.suspended_at as string) ?? null,
          buriedUntil: (row.buried_until as string) ?? null,
          anchor: (row.anchor as string) ?? null,
        });
      }
      stmt.free();

      // Convert to map
      const existingById = new Map<string, Flashcard>();
      existingFlashcards.forEach((flashcard) => {
        existingById.set(flashcard.id, flashcard);
      });

      // Tokens that carry their ids need no lookup; minted ones still resolve
      // through the bindings, read only for the keys this note holds.
      const bindings = this.loadBindings(
        expandedCards
          .map((card) => card.anchorKey)
          .filter((key): key is string => !!key && !isIdKey(key))
      );

      /*
       * Safety: a deck that had cards and now parses to none is refused.
       *
       * This used to require the file to be EMPTY, on the reasoning that only a
       * read race could empty a live deck file. That left the larger hole open:
       * a note that reads perfectly and parses to zero — a header level that no
       * longer matches the profile, a parser that stopped recognising the format
       * — deleted every card in the deck, and a full refresh applied it to the
       * whole vault at once.
       *
       * The asymmetry is what decides it. Refusing costs a sync that the next
       * one repeats; proceeding costs the deck. Scheduling survives either way
       * (ids are content-derived and review_logs restores state), but only if
       * the cards come back at all.
       *
       * Only a caller that knows the note is unchanged asks for this, via
       * refuseEmptyResult; left alone, an empty parse empties the deck as it
       * always has. The caller must not stamp mtime for a skipped sync.
       */
      if (
        wouldEmptyDeck(expandedCards.length, existingFlashcards.length, {
          contentEmpty: data.fileContent.trim() === "",
          refuseEmptyResult: data.refuseEmptyResult,
        })
      ) {
        return {
          success: true,
          parsedCount: 0,
          operationsCount: 0,
          duplicatesSkipped: 0,
          skippedEmptyParse: true,
        };
      }

      // Id -> who claimed it first: a content signature, and whether a token fixed it.
      const processedIds = new Map<string, { signature: string; front: string; anchored: boolean }>();
      const batchOperations: BatchOperation[] = [];
      let duplicatesSkipped = 0;
      const idCollisions: Array<{ id: string; fronts: [string, string] }> = [];

      // Build lists for smart rename detection
      interface ParsedCardData {
        parsed: {
          front: string;
          back: string;
          notes: string;
          type: FlashcardType;
          breadcrumb: string;
          tags: string[];
          isReverse?: boolean;
          clozeText?: string;
          clozeOrder?: number;
          sourceNodeId?: string;
          edgeId?: string;
          hint?: string;
          templateRow?: TemplateRow;
          anchorKey?: string;
        };
        flashcardId: string;
        contentHash: string;
      }
      const cardsToCreate: ParsedCardData[] = [];
      const reverseCardsToCreate: ParsedCardData[] = [];
      const spatialCardsToCreate: ParsedCardData[] = [];
      const anchoredCardsToCreate: ParsedCardData[] = [];
      const cardsToDelete: Flashcard[] = [];

      // Process parsed cards - first pass: identify creates and updates
      progressCallback?.(30, "Processing flashcards...");
      for (
        let cardIndex = 0;
        cardIndex < Math.min(expandedCards.length, 50000);
        cardIndex++
      ) {
        let parsed = expandedCards[cardIndex];

        // Update progress periodically
        if (cardIndex % 100 === 0) {
          const cardProgress =
            30 + (cardIndex / Math.min(expandedCards.length, 50000)) * 30;
          progressCallback?.(
            cardProgress,
            `Processing card ${cardIndex + 1}/${Math.min(
              expandedCards.length,
              50000
            )}...`
          );
        }

        // ID generation varies by card type (all IDs are deck-independent):
        //   - spatial (non-cloze) -> generateSpatialFlashcardId(front, edgeId)
        //   - cloze-with-edgeId (spatial cloze) -> generateSpatialClozeFlashcardId
        //   - occlusion-v2 -> generateOcclusionV2FlashcardId(heading, imageName, maskId)
        //   - cloze / image-occlusion -> generateClozeFlashcardId
        //   - reverse -> generateReverseFlashcardId
        //   - default markdown -> generateFlashcardId
        // For canvas cards, sourceNodeId is mixed into the (non-spatial) hash
        // so identical fronts in different nodes produce distinct IDs.
        const isOcclusionV2 = parsed.type === "image-occlusion-v2";
        const isClozeType = parsed.type === "cloze" || parsed.type === "image-occlusion";
        const isSpatial = parsed.type === "spatial";
        const hasEdge = !!parsed.edgeId;
        let flashcardId: string;
        if (isOcclusionV2) {
          // Identity keyed on the heading + stable mask id, so moving/editing a
          // box (or relocating the image) keeps the card's FSRS history.
          flashcardId = generateOcclusionV2FlashcardId(
            parsed.breadcrumb,
            occlusionImageName(parsed.imagePath!),
            parsed.maskId!,
          );
        } else if (isSpatial && hasEdge) {
          flashcardId = generateSpatialFlashcardId(parsed.front, parsed.edgeId!);
        } else if (isClozeType && hasEdge) {
          flashcardId = generateSpatialClozeFlashcardId(
            parsed.front,
            parsed.edgeId!,
            parsed.clozeText!,
            parsed.clozeOrder!,
          );
        } else if (isClozeType) {
          flashcardId = generateClozeFlashcardId(parsed.front, parsed.clozeText!, parsed.clozeOrder!, parsed.sourceNodeId);
        } else if (parsed.isReverse) {
          flashcardId = generateReverseFlashcardId(parsed.back, parsed.sourceNodeId);
        } else {
          flashcardId = generateFlashcardId(parsed.front, parsed.sourceNodeId);
        }
        // Anchor-first matching: the token's id (or a minted token's binding)
        // overrides content-derived identity, so an edit keeps the card's id.
        let anchored = false;
        if (parsed.anchorKey && isIdKey(parsed.anchorKey)) {
          const carried = cardIdForKey(parsed.anchorKey);
          if (carried && processedIds.has(carried)) {
            // A copied token: the first card in the note keeps the id, the copy
            // falls back to its content and gets its own token at its first review.
            parsed = { ...parsed, anchorKey: undefined };
          } else if (carried) {
            flashcardId = carried;
            anchored = true;
          }
        } else if (parsed.anchorKey) {
          const boundId = bindings.get(parsed.anchorKey);
          if (boundId) {
            flashcardId = boundId;
            anchored = true;
          }
        }
        // Table rows fold their full cells into the hash so editing any column
        // (even ones only a template reads) triggers a re-sync of the card.
        // V2 occlusion hashes only the active mask, so editing one box never
        // churns its siblings.
        const contentHash = parsed.templateRow
          ? generateContentHash(parsed.back + "::row::" + JSON.stringify(parsed.templateRow.cells))
          : isOcclusionV2
          ? generateContentHash(occlusionV2HashInput(parsed.back, parsed.maskId!))
          : isClozeType
          ? generateContentHash(parsed.back + "::" + parsed.clozeText)
          : generateContentHash(parsed.back);
        const existingCard = existingById.get(flashcardId);

        const signature = [
          parsed.type,
          parsed.isReverse ? "rev" : "",
          parsed.front,
          parsed.clozeText ?? "",
          parsed.sourceNodeId ?? "",
          parsed.edgeId ?? "",
          parsed.maskId ?? "",
        ].join("\u0000");
        const claimed = processedIds.get(flashcardId);
        if (claimed) {
          duplicatesSkipped++;
          if (claimed.signature !== signature) {
            idCollisions.push({ id: flashcardId, fronts: [claimed.front, parsed.front] });
          }
          continue;
        }
        processedIds.set(flashcardId, { signature, front: parsed.front, anchored });

        if (existingCard) {
          // Update if content, breadcrumb, notes, front, type, tags, hint, or
          // anchor changed. Tags/hint/anchor are excluded from contentHash, so
          // they need explicit comparisons.
          const contentChanged =
            existingCard.contentHash !== contentHash ||
            existingCard.breadcrumb !== parsed.breadcrumb ||
            existingCard.notes !== (parsed.notes || "") ||
            existingCard.front !== parsed.front ||
            existingCard.type !== parsed.type ||
            (existingCard.hint || "") !== (parsed.hint || "") ||
            !tagsEqual(existingCard.tags, parsed.tags);
          const anchorChanged =
            (existingCard.anchor ?? null) !== (parsed.anchorKey ?? null);
          if (!contentChanged && anchorChanged) {
            // A token-only change leaves `modified` alone, so remote reviews still apply.
            batchOperations.push({
              type: "anchor",
              flashcardId: existingCard.id,
              anchor: parsed.anchorKey ?? null,
            });
          } else if (contentChanged) {
            batchOperations.push({
              type: "update",
              flashcardId: existingCard.id,
              updates: {
                front: parsed.front,
                back: parsed.back,
                notes: parsed.notes || "",
                type: parsed.type,
                contentHash: contentHash,
                breadcrumb: parsed.breadcrumb,
                tags: parsed.tags,
                hint: parsed.hint || "",
                clozeText: parsed.clozeText ?? null,
                clozeOrder: parsed.clozeOrder ?? null,
                templateRow: parsed.templateRow ?? null,
                anchor: parsed.anchorKey ?? null,
              },
            });
          }
          // Adopt: the file carries a key with no binding, and this card owns
          // the key's history (it has been reviewed). Bindings are never
          // written speculatively — a fresh device must wait for the merge.
          if (
            !anchored &&
            parsed.anchorKey &&
            !isIdKey(parsed.anchorKey) &&
            (existingCard.lastReviewed !== null || existingCard.repetitions > 0)
          ) {
            batchOperations.push({
              type: "bind",
              bindAnchor: {
                anchor: parsed.anchorKey,
                flashcardId: existingCard.id,
              },
            });
          }
        } else {
          // Card doesn't exist — route to the appropriate create list.
          // Anchor-matched cards, spatial cards (canvas edges) and V2
          // occlusion cards have deterministic identity, so they skip rename
          // fuzzy-match — siblings sharing a front must never cross-migrate.
          if (anchored) {
            anchoredCardsToCreate.push({ parsed, flashcardId, contentHash });
          } else if (hasEdge || isOcclusionV2) {
            spatialCardsToCreate.push({ parsed, flashcardId, contentHash });
          } else if (parsed.isReverse) {
            reverseCardsToCreate.push({ parsed, flashcardId, contentHash });
          } else {
            cardsToCreate.push({ parsed, flashcardId, contentHash });
          }
        }
      }

      // Identify cards to delete. Scoped to THIS deck's existingById minus the
      // parsed ids, so a card the upsert moved into another deck (same front in two
      // files) is never also deleted here — it's relocated (last sync wins), not lost.
      progressCallback?.(60, "Identifying orphaned flashcards...");
      existingById.forEach((existingCard, flashcardId) => {
        if (!processedIds.has(flashcardId)) {
          cardsToDelete.push(existingCard);
        }
      });

      // Smart Rename Detection. A rename = same card, edited front: the old id's
      // delete + the new id's create are paired into a "migrate" that carries the
      // scheduling state (and re-points review_logs). Matching is by identical
      // back, resolved through a Map — O(creates), with no pairwise sweep.
      progressCallback?.(65, "Detecting renamed flashcards...");
      const matchedCreates = new Set<number>();
      const matchedDeletes = new Set<number>();

      const pushMigrate = (newCardData: ParsedCardData, oldCard: Flashcard): void => {
        batchOperations.push({
          type: "migrate",
          oldId: oldCard.id,
          flashcard: {
            id: newCardData.flashcardId,
            deckId: data.deckId,
            front: newCardData.parsed.front,
            back: newCardData.parsed.back,
            notes: newCardData.parsed.notes || "",
            type: newCardData.parsed.type,
            sourceFile: data.deckFilepath,
            contentHash: newCardData.contentHash,
            breadcrumb: newCardData.parsed.breadcrumb,
            tags: newCardData.parsed.tags,
            hint: newCardData.parsed.hint || "",
            clozeText: newCardData.parsed.clozeText ?? null,
            clozeOrder: newCardData.parsed.clozeOrder ?? null,
            sourceNodeId: newCardData.parsed.sourceNodeId ?? null,
            edgeId: newCardData.parsed.edgeId ?? null,
            templateRow: newCardData.parsed.templateRow ?? null,
            anchor: newCardData.parsed.anchorKey ?? null,
            state: oldCard.state,
            dueDate: oldCard.dueDate,
            interval: oldCard.interval,
            repetitions: oldCard.repetitions,
            difficulty: oldCard.difficulty,
            stability: oldCard.stability,
            lapses: oldCard.lapses,
            lastReviewed: oldCard.lastReviewed,
            suspendedAt: oldCard.suspendedAt,
            buriedUntil: oldCard.buriedUntil,
          },
          // A migrate carries the old card's history onto the new id, so a
          // key in the file is adopt-worthy here.
          ...(newCardData.parsed.anchorKey
            ? {
                bindAnchor: {
                  anchor: newCardData.parsed.anchorKey,
                  flashcardId: newCardData.flashcardId,
                },
              }
            : {}),
        });
      };

      // Id switch: a token now carries a different id for a row this device
      // still holds under another. Identical content means the same card, so merge.
      const sameCard = (row: Flashcard, data: ParsedCardData): boolean =>
        row.type === data.parsed.type &&
        row.front === data.parsed.front &&
        row.back === data.parsed.back &&
        (row.clozeText ?? null) === (data.parsed.clozeText ?? null) &&
        (row.clozeOrder ?? null) === (data.parsed.clozeOrder ?? null) &&
        row.id.slice(0, row.id.indexOf("_")) ===
          data.flashcardId.slice(0, data.flashcardId.indexOf("_"));
      const mergedAnchored = new Set<number>();
      anchoredCardsToCreate.forEach((newCardData, createIdx) => {
        const key = newCardData.parsed.anchorKey;
        if (!key || !isIdKey(key)) return;
        const deleteIdx = cardsToDelete.findIndex(
          (row, idx) => !matchedDeletes.has(idx) && sameCard(row, newCardData)
        );
        if (deleteIdx < 0) return;
        pushMigrate(newCardData, cardsToDelete[deleteIdx]);
        mergedAnchored.add(createIdx);
        matchedDeletes.add(deleteIdx);
      });

      // Strong pass: identical back → first unmatched delete with that back.
      // Anchored rows never participate: a vanished anchored card follows
      // intended-reset semantics, not fuzzy re-attachment.
      const deletesByBack = new Map<string, number[]>();
      for (let deleteIdx = 0; deleteIdx < cardsToDelete.length; deleteIdx++) {
        if (cardsToDelete[deleteIdx].anchor || matchedDeletes.has(deleteIdx)) continue;
        const queue = deletesByBack.get(cardsToDelete[deleteIdx].back);
        if (queue) queue.push(deleteIdx);
        else deletesByBack.set(cardsToDelete[deleteIdx].back, [deleteIdx]);
      }
      for (let createIdx = 0; createIdx < cardsToCreate.length; createIdx++) {
        const newCardData = cardsToCreate[createIdx];
        const queue = deletesByBack.get(newCardData.parsed.back);
        const deleteIdx = queue?.shift();
        if (deleteIdx === undefined) continue;
        pushMigrate(newCardData, cardsToDelete[deleteIdx]);
        matchedCreates.add(createIdx);
        matchedDeletes.add(deleteIdx);
      }

      // No fuzzy pass. Front similarity was a guess, and a capped guess at
      // that — the budget below turned it off on exactly the large decks where
      // a rename is most likely, so it was never a floor anyone could rely on.
      // Renames are recovered exactly instead: by anchor where a card has one,
      // and by identical back above where it does not.

      // Process remaining creates (not matched)
      progressCallback?.(70, "Creating new flashcards...");
      for (let createIdx = 0; createIdx < cardsToCreate.length; createIdx++) {
        if (matchedCreates.has(createIdx)) continue;

        const newCardData = cardsToCreate[createIdx];

        // Check for review history
        const reviewLogStmt = this.db.prepare(`
                    SELECT new_state, new_interval_minutes, new_repetitions, new_difficulty,
                           new_stability, new_lapses, reviewed_at
                    FROM review_logs
                    WHERE flashcard_id = ?
                    ORDER BY reviewed_at DESC
                    LIMIT 1
                `);
        reviewLogStmt.bind([newCardData.flashcardId]);
        const reviewLogRow = reviewLogStmt.step() ? reviewLogStmt.get() : null;
        reviewLogStmt.free();

        // Create new flashcard
        const flashcard: Omit<Flashcard, "created" | "modified"> = {
          id: newCardData.flashcardId,
          deckId: data.deckId,
          front: newCardData.parsed.front,
          back: newCardData.parsed.back,
          notes: newCardData.parsed.notes || "",
          type: newCardData.parsed.type,
          sourceFile: data.deckFilepath,
          contentHash: newCardData.contentHash,
          breadcrumb: newCardData.parsed.breadcrumb,
          tags: newCardData.parsed.tags,
          hint: newCardData.parsed.hint || "",
          clozeText: newCardData.parsed.clozeText ?? null,
          clozeOrder: newCardData.parsed.clozeOrder ?? null,
          sourceNodeId: newCardData.parsed.sourceNodeId ?? null,
          edgeId: newCardData.parsed.edgeId ?? null,
          templateRow: newCardData.parsed.templateRow ?? null,
          anchor: newCardData.parsed.anchorKey ?? null,
          state: reviewLogRow ? (reviewLogRow[0] as "new" | "review") : "new",
          dueDate:
            reviewLogRow && reviewLogRow[6] && reviewLogRow[1]
              ? new Date(
                  new Date(reviewLogRow[6] as string).getTime() +
                    (reviewLogRow[1] as number) * 60 * 1000
                ).toISOString()
              : new Date().toISOString(),
          interval: reviewLogRow ? (reviewLogRow[1] as number) : 0,
          repetitions: reviewLogRow ? (reviewLogRow[2] as number) : 0,
          difficulty: reviewLogRow ? (reviewLogRow[3] as number) : 5.0,
          stability: reviewLogRow ? (reviewLogRow[4] as number) : 2.5,
          lapses: reviewLogRow ? (reviewLogRow[5] as number) : 0,
          lastReviewed: reviewLogRow ? (reviewLogRow[6] as string) : null,
          ...this.overlayState(newCardData.flashcardId),
        };

        batchOperations.push({
          type: "create",
          flashcard: flashcard,
          // Restored history proves ownership of the key in the file.
          ...(reviewLogRow && newCardData.parsed.anchorKey
            ? {
                bindAnchor: {
                  anchor: newCardData.parsed.anchorKey,
                  flashcardId: newCardData.flashcardId,
                },
              }
            : {}),
        });
      }

      // Process anchored creates: the binding already fixed their identity, so
      // they never participate in rename detection. Restoration is keyed by
      // the bound id — this is what re-attaches history on a rebuilt or fresh
      // database even after the card's content was edited.
      for (let createIdx = 0; createIdx < anchoredCardsToCreate.length; createIdx++) {
        if (mergedAnchored.has(createIdx)) continue;
        const newCardData = anchoredCardsToCreate[createIdx];
        const reviewLogStmt = this.db.prepare(`
                    SELECT new_state, new_interval_minutes, new_repetitions, new_difficulty,
                           new_stability, new_lapses, reviewed_at
                    FROM review_logs
                    WHERE flashcard_id = ?
                    ORDER BY reviewed_at DESC
                    LIMIT 1
                `);
        reviewLogStmt.bind([newCardData.flashcardId]);
        const reviewLogRow = reviewLogStmt.step() ? reviewLogStmt.get() : null;
        reviewLogStmt.free();

        const flashcard: Omit<Flashcard, "created" | "modified"> = {
          id: newCardData.flashcardId,
          deckId: data.deckId,
          front: newCardData.parsed.front,
          back: newCardData.parsed.back,
          notes: newCardData.parsed.notes || "",
          type: newCardData.parsed.type,
          sourceFile: data.deckFilepath,
          contentHash: newCardData.contentHash,
          breadcrumb: newCardData.parsed.breadcrumb,
          tags: newCardData.parsed.tags,
          hint: newCardData.parsed.hint || "",
          clozeText: newCardData.parsed.clozeText ?? null,
          clozeOrder: newCardData.parsed.clozeOrder ?? null,
          sourceNodeId: newCardData.parsed.sourceNodeId ?? null,
          edgeId: newCardData.parsed.edgeId ?? null,
          templateRow: newCardData.parsed.templateRow ?? null,
          anchor: newCardData.parsed.anchorKey ?? null,
          state: reviewLogRow ? (reviewLogRow[0] as "new" | "review") : "new",
          dueDate:
            reviewLogRow && reviewLogRow[6] && reviewLogRow[1]
              ? new Date(
                  new Date(reviewLogRow[6] as string).getTime() +
                    (reviewLogRow[1] as number) * 60 * 1000
                ).toISOString()
              : new Date().toISOString(),
          interval: reviewLogRow ? (reviewLogRow[1] as number) : 0,
          repetitions: reviewLogRow ? (reviewLogRow[2] as number) : 0,
          difficulty: reviewLogRow ? (reviewLogRow[3] as number) : 5.0,
          stability: reviewLogRow ? (reviewLogRow[4] as number) : 2.5,
          lapses: reviewLogRow ? (reviewLogRow[5] as number) : 0,
          lastReviewed: reviewLogRow ? (reviewLogRow[6] as string) : null,
          ...this.overlayState(newCardData.flashcardId),
        };

        batchOperations.push({
          type: "create",
          flashcard: flashcard,
        });
      }

      // Process reverse cards (never participate in rename detection)
      for (const newCardData of reverseCardsToCreate) {
        const reviewLogStmt = this.db.prepare(`
                    SELECT new_state, new_interval_minutes, new_repetitions, new_difficulty,
                           new_stability, new_lapses, reviewed_at
                    FROM review_logs
                    WHERE flashcard_id = ?
                    ORDER BY reviewed_at DESC
                    LIMIT 1
                `);
        reviewLogStmt.bind([newCardData.flashcardId]);
        const reviewLogRow = reviewLogStmt.step() ? reviewLogStmt.get() : null;
        reviewLogStmt.free();

        const flashcard: Omit<Flashcard, "created" | "modified"> = {
          id: newCardData.flashcardId,
          deckId: data.deckId,
          front: newCardData.parsed.front,
          back: newCardData.parsed.back,
          notes: newCardData.parsed.notes || "",
          type: newCardData.parsed.type,
          sourceFile: data.deckFilepath,
          contentHash: newCardData.contentHash,
          breadcrumb: newCardData.parsed.breadcrumb,
          tags: newCardData.parsed.tags,
          hint: "",
          clozeText: null,
          clozeOrder: null,
          sourceNodeId: newCardData.parsed.sourceNodeId ?? null,
          edgeId: null,
          templateRow: null,
          anchor: newCardData.parsed.anchorKey ?? null,
          state: reviewLogRow ? (reviewLogRow[0] as "new" | "review") : "new",
          dueDate:
            reviewLogRow && reviewLogRow[6] && reviewLogRow[1]
              ? new Date(
                  new Date(reviewLogRow[6] as string).getTime() +
                    (reviewLogRow[1] as number) * 60 * 1000
                ).toISOString()
              : new Date().toISOString(),
          interval: reviewLogRow ? (reviewLogRow[1] as number) : 0,
          repetitions: reviewLogRow ? (reviewLogRow[2] as number) : 0,
          difficulty: reviewLogRow ? (reviewLogRow[3] as number) : 5.0,
          stability: reviewLogRow ? (reviewLogRow[4] as number) : 2.5,
          lapses: reviewLogRow ? (reviewLogRow[5] as number) : 0,
          lastReviewed: reviewLogRow ? (reviewLogRow[6] as string) : null,
          ...this.overlayState(newCardData.flashcardId),
        };

        batchOperations.push({
          type: "create",
          flashcard: flashcard,
          ...(reviewLogRow && newCardData.parsed.anchorKey
            ? {
                bindAnchor: {
                  anchor: newCardData.parsed.anchorKey,
                  flashcardId: newCardData.flashcardId,
                },
              }
            : {}),
        });
      }

      // Process spatial cards (never participate in rename detection — IDs are
      // already deterministic from the canvas edge id).
      for (const newCardData of spatialCardsToCreate) {
        const reviewLogStmt = this.db.prepare(`
                    SELECT new_state, new_interval_minutes, new_repetitions, new_difficulty,
                           new_stability, new_lapses, reviewed_at
                    FROM review_logs
                    WHERE flashcard_id = ?
                    ORDER BY reviewed_at DESC
                    LIMIT 1
                `);
        reviewLogStmt.bind([newCardData.flashcardId]);
        const reviewLogRow = reviewLogStmt.step() ? reviewLogStmt.get() : null;
        reviewLogStmt.free();

        const flashcard: Omit<Flashcard, "created" | "modified"> = {
          id: newCardData.flashcardId,
          deckId: data.deckId,
          front: newCardData.parsed.front,
          back: newCardData.parsed.back,
          notes: newCardData.parsed.notes || "",
          type: newCardData.parsed.type,
          sourceFile: data.deckFilepath,
          contentHash: newCardData.contentHash,
          breadcrumb: newCardData.parsed.breadcrumb,
          tags: newCardData.parsed.tags,
          hint: newCardData.parsed.hint || "",
          clozeText: newCardData.parsed.clozeText ?? null,
          clozeOrder: newCardData.parsed.clozeOrder ?? null,
          sourceNodeId: newCardData.parsed.sourceNodeId ?? null,
          edgeId: newCardData.parsed.edgeId ?? null,
          templateRow: newCardData.parsed.templateRow ?? null,
          anchor: newCardData.parsed.anchorKey ?? null,
          state: reviewLogRow ? (reviewLogRow[0] as "new" | "review") : "new",
          dueDate:
            reviewLogRow && reviewLogRow[6] && reviewLogRow[1]
              ? new Date(
                  new Date(reviewLogRow[6] as string).getTime() +
                    (reviewLogRow[1] as number) * 60 * 1000
                ).toISOString()
              : new Date().toISOString(),
          interval: reviewLogRow ? (reviewLogRow[1] as number) : 0,
          repetitions: reviewLogRow ? (reviewLogRow[2] as number) : 0,
          difficulty: reviewLogRow ? (reviewLogRow[3] as number) : 5.0,
          stability: reviewLogRow ? (reviewLogRow[4] as number) : 2.5,
          lapses: reviewLogRow ? (reviewLogRow[5] as number) : 0,
          lastReviewed: reviewLogRow ? (reviewLogRow[6] as string) : null,
          ...this.overlayState(newCardData.flashcardId),
        };

        batchOperations.push({
          type: "create",
          flashcard: flashcard,
          ...(reviewLogRow && newCardData.parsed.anchorKey
            ? {
                bindAnchor: {
                  anchor: newCardData.parsed.anchorKey,
                  flashcardId: newCardData.flashcardId,
                },
              }
            : {}),
        });
      }

      // Process remaining deletes (not matched)
      progressCallback?.(75, "Cleaning up orphaned flashcards...");
      for (let deleteIdx = 0; deleteIdx < cardsToDelete.length; deleteIdx++) {
        if (matchedDeletes.has(deleteIdx)) continue;

        batchOperations.push({
          type: "delete",
          flashcardId: cardsToDelete[deleteIdx].id,
        });
      }

      // Execute batch operations
      if (batchOperations.length > 0) {
        progressCallback?.(
          85,
          `Executing ${batchOperations.length} database operations...`
        );
        this.executeBatchOperations(batchOperations);
      }

      // Update deck timestamp
      progressCallback?.(95, "Finalizing deck update...");
      const updateDeckStmt = this.db.prepare(
        "UPDATE decks SET modified = datetime('now') WHERE id = ?"
      );
      updateDeckStmt.run([data.deckId]);
      updateDeckStmt.free();

      progressCallback?.(100, "Sync completed successfully!");
      return {
        success: true,
        parsedCount: parsedCards.length,
        operationsCount: batchOperations.length,
        duplicatesSkipped,
        ...(idCollisions.length > 0 ? { idCollisions } : {}),
      };
    } catch (error) {
      throw new Error(`Sync failed: ${(error as Error).message}`);
    }
  }
}
