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
import { levenshteinSimilarityAbove } from "../utils/string";

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
  type: "create" | "update" | "delete" | "migrate";
  flashcardId?: string;
  flashcard?: Omit<Flashcard, "created" | "modified">;
  updates?: FlashcardUpdates;
  oldId?: string;
  newId?: string;
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

  /**
   * Execute batch database operations using raw SQL
   */
  executeBatchOperations(operations: BatchOperation[]): void {
    for (const op of operations) {
      if (op.type === "migrate" && op.oldId && op.flashcard) {
        // Safety check: if target ID already exists (hash collision), just delete the old card
        const card = op.flashcard;
        const checkStmt = this.db.prepare("SELECT id FROM flashcards WHERE id = ?");
        checkStmt.bind([card.id]);
        const targetExists = checkStmt.step();
        checkStmt.free();
        if (targetExists) {
          const deleteStmt = this.db.prepare("DELETE FROM flashcards WHERE id = ?");
          deleteStmt.run([op.oldId]);
          deleteStmt.free();
          continue;
        }

        // Migrate flashcard identity: update flashcard ID and content
        const updateStmt = this.db.prepare(`
                    UPDATE flashcards
                    SET id = ?, front = ?, back = ?, content_hash = ?, breadcrumb = ?, notes = ?,
                        type = ?, cloze_text = ?, cloze_order = ?, source_node_id = ?, edge_id = ?,
                        hint = ?, tags = ?, template_row = ?, modified = datetime('now')
                    WHERE id = ?
                `);
        updateStmt.run([
          card.id,
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
          op.oldId,
        ]);
        updateStmt.free();

        // Migrate review_logs to new ID (critical since FK removed)
        const reviewLogStmt = this.db.prepare(
          "UPDATE review_logs SET flashcard_id = ? WHERE flashcard_id = ?"
        );
        reviewLogStmt.run([card.id, op.oldId]);
        reviewLogStmt.free();
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
                        suspended_at, buried_until, template_row
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)
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
        ]);
        stmt.free();
      } else if (op.type === "update" && op.flashcardId && op.updates) {
        const stmt = this.db.prepare(`
                    UPDATE flashcards
                    SET front = ?, back = ?, type = ?, content_hash = ?, breadcrumb = ?, notes = ?,
                        cloze_text = ?, cloze_order = ?, hint = ?, tags = ?, template_row = ?,
                        modified = datetime('now')
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
          );

      // Expand with reverse cards if enabled. Cloze, image-occlusion, and
      // spatial cards never reverse — spatial edges are directional, and the
      // cloze/image-occlusion formats don't support a sensible flip either.
      const expandedCards = [...parsedCards];
      if (data.reverseCards) {
        for (const card of parsedCards) {
          if (
            card.back &&
            card.type !== "cloze" &&
            card.type !== "image-occlusion" &&
            card.type !== "image-occlusion-v2" &&
            card.type !== "spatial" &&
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
        });
      }
      stmt.free();

      // Convert to map
      const existingById = new Map<string, Flashcard>();
      existingFlashcards.forEach((flashcard) => {
        existingById.set(flashcard.id, flashcard);
      });

      // Safety: an EMPTY file read for a deck that still has cards is a read race,
      // not a real edit — a live deck file always has at least its frontmatter tag,
      // so empty content can never be a legitimate "user removed every card".
      // Deleting here would wipe the deck; abort so the next sync retries. Non-empty
      // content that parses to zero (the user genuinely cleared the file, or a
      // canvas whose last edge was removed) proceeds and deletes normally. The
      // caller must not stamp mtime for a skipped sync.
      if (
        expandedCards.length === 0 &&
        existingFlashcards.length > 0 &&
        data.fileContent.trim() === ""
      ) {
        return {
          success: true,
          parsedCount: 0,
          operationsCount: 0,
          duplicatesSkipped: 0,
          skippedEmptyParse: true,
        };
      }

      const processedIds = new Set<string>();
      const batchOperations: BatchOperation[] = [];
      let duplicatesSkipped = 0;

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
        };
        flashcardId: string;
        contentHash: string;
      }
      const cardsToCreate: ParsedCardData[] = [];
      const reverseCardsToCreate: ParsedCardData[] = [];
      const spatialCardsToCreate: ParsedCardData[] = [];
      const cardsToDelete: Flashcard[] = [];

      // Process parsed cards - first pass: identify creates and updates
      progressCallback?.(30, "Processing flashcards...");
      for (
        let cardIndex = 0;
        cardIndex < Math.min(expandedCards.length, 50000);
        cardIndex++
      ) {
        const parsed = expandedCards[cardIndex];

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

        if (processedIds.has(flashcardId)) {
          duplicatesSkipped++;
          continue;
        }
        processedIds.add(flashcardId);

        if (existingCard) {
          // Update if content, breadcrumb, notes, front, type, tags, or hint changed.
          // Tags and hint are excluded from contentHash, so they need explicit comparisons.
          if (
            existingCard.contentHash !== contentHash ||
            existingCard.breadcrumb !== parsed.breadcrumb ||
            existingCard.notes !== (parsed.notes || "") ||
            existingCard.front !== parsed.front ||
            existingCard.type !== parsed.type ||
            (existingCard.hint || "") !== (parsed.hint || "") ||
            !tagsEqual(existingCard.tags, parsed.tags)
          ) {
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
              },
            });
          }
        } else {
          // Card doesn't exist — route to the appropriate create list.
          // Spatial cards (canvas edges) and V2 occlusion cards get a
          // deterministic id (from the edge / mask id), so they skip rename
          // fuzzy-match — siblings sharing a front must never cross-migrate.
          if (hasEdge || isOcclusionV2) {
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
      // scheduling state (and re-points review_logs). Strong matches (identical
      // back) resolve first via a Map — O(creates). Only the leftovers try the
      // fuzzy front comparison, which is pre-filtered and capped: an uncapped
      // creates × deletes Levenshtein sweep froze multi-minute on large
      // re-imports where both sides' content had shifted.
      progressCallback?.(65, "Detecting renamed flashcards...");
      const matchedCreates = new Set<number>();
      const matchedDeletes = new Set<number>();
      const FUZZY_PAIR_BUDGET = 200_000;

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
        });
      };

      // Strong pass: identical back → first unmatched delete with that back.
      const deletesByBack = new Map<string, number[]>();
      for (let deleteIdx = 0; deleteIdx < cardsToDelete.length; deleteIdx++) {
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

      // Fuzzy pass (leftovers only): >80% front similarity. Skipped entirely when
      // the pair count exceeds the budget — unmatched cards then fall back to
      // plain create/delete, and the create still restores FSRS from review_logs.
      const fuzzyCreates = cardsToCreate.length - matchedCreates.size;
      const fuzzyDeletes = cardsToDelete.length - matchedDeletes.size;
      if (fuzzyCreates * fuzzyDeletes <= FUZZY_PAIR_BUDGET) {
        for (let createIdx = 0; createIdx < cardsToCreate.length; createIdx++) {
          if (matchedCreates.has(createIdx)) continue;
          const newCardData = cardsToCreate[createIdx];

          for (let deleteIdx = 0; deleteIdx < cardsToDelete.length; deleteIdx++) {
            if (matchedDeletes.has(deleteIdx)) continue;
            const oldCard = cardsToDelete[deleteIdx];

            if (!levenshteinSimilarityAbove(newCardData.parsed.front, oldCard.front, 80)) {
              continue;
            }
            pushMigrate(newCardData, oldCard);
            matchedCreates.add(createIdx);
            matchedDeletes.add(deleteIdx);
            break; // Found a match, move to next create
          }
        }
      } else {
        progressCallback?.(
          65,
          `Skipping fuzzy rename detection (${fuzzyCreates}x${fuzzyDeletes} pairs exceed budget)`
        );
      }

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
          suspendedAt: null,
          buriedUntil: null,
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
          suspendedAt: null,
          buriedUntil: null,
        };

        batchOperations.push({
          type: "create",
          flashcard: flashcard,
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
          suspendedAt: null,
          buriedUntil: null,
        };

        batchOperations.push({
          type: "create",
          flashcard: flashcard,
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
      };
    } catch (error) {
      throw new Error(`Sync failed: ${(error as Error).message}`);
    }
  }
}
