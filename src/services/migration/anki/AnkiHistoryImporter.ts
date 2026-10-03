import type { Flashcard, ReviewLog } from "../../../database/types";
import type { IDatabaseService } from "../../../database/DatabaseService.interface";
import {
  getMaxIntervalDaysForProfile,
  getMinMinutesForProfile,
  normalizeProfile,
} from "../../../algorithm/fsrs-weights";
import { generateContentHash } from "../../../utils/hash";
import { AnkiDeckRenderer } from "./AnkiDeckRenderer";
import type { FsrsState } from "../LegacySrMigrator";
import { SrHistoryImporter } from "../SrHistoryImporter";
import type { HistoryDb, MigrationProfileFsrs } from "../SrHistoryImporter";
import type { AnkiParsedCard, AnkiScheduling } from "./AnkiTypes";

const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;
const MINUTES_PER_DAY = 1440;

export interface AnkiRevlogRow {
  id: number; // review timestamp in ms (also the row id)
  cid: number; // card id
  ease: number; // 1-4
  ivl: number; // resulting interval (days if positive, seconds if negative)
  lastIvl: number; // previous interval
  factor: number; // ease, per-mille
}

/** The history writers, plus one read of each deck's rows. */
export type AnkiHistoryDb = HistoryDb & Pick<IDatabaseService, "querySql">;

/** A deck row's scheduling, and its newest review made in Decks rather than imported. */
interface ImportedRow {
  id: string;
  state: string;
  due_date: string;
  interval: number;
  repetitions: number;
  difficulty: number;
  stability: number;
  lapses: number;
  last_reviewed: string | null;
  own_reviewed_at: string | null;
}

// Importers write log_anki_* and log_migrate_*; every other log is a review made in Decks.
const rowsSql = (count: number): string => `
  SELECT f.id AS id, f.state AS state, f.due_date AS due_date, f.interval AS interval,
         f.repetitions AS repetitions, f.difficulty AS difficulty, f.stability AS stability,
         f.lapses AS lapses, f.last_reviewed AS last_reviewed,
         (SELECT MAX(rl.reviewed_at) FROM review_logs rl
           WHERE rl.flashcard_id = f.id
             AND rl.id NOT GLOB 'log_anki_*' AND rl.id NOT GLOB 'log_migrate_*') AS own_reviewed_at
  FROM flashcards f WHERE f.id IN (${Array(count).fill("?").join(",")})`;
const ROWS_PER_QUERY = 400;

export interface AnkiDeckItem {
  deckId: string;
  profileFsrs: MigrationProfileFsrs;
  cards: AnkiParsedCard[];
}

export interface AnkiImportHistoryOptions {
  // Anki `due`/`crt` are day-offsets from collection creation; supplying the
  // creation time lets due dates be reconstructed. Falls back to now + interval.
  collectionCreatedMs?: number;
  // Real Anki review rows, grouped by card id, imported as a review timeline.
  revlogByCard?: Map<number, AnkiRevlogRow[]>;
  // Reports progress as cards are processed (for the import modal's progress bar).
  onProgress?: (done: number, total: number) => void;
}

const RATING_LABELS: Record<number, ReviewLog["ratingLabel"]> = {
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
};

function clampDifficulty(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, value));
}

function clampRating(ease: number): 1 | 2 | 3 | 4 {
  if (ease <= 1) return 1;
  if (ease >= 4) return 4;
  return ease === 2 ? 2 : 3;
}

// Anki ivl: days when positive, seconds when negative (learning steps).
function ivlToDays(ivl: number): number {
  return ivl < 0 ? Math.max(Math.abs(ivl) / SECONDS_PER_DAY, 0) : ivl;
}

/**
 * Imports Anki scheduling + review history into Decks. Builds an {@link FsrsState}
 * per card from either the native FSRS blob in `cards.data` or an SM-2→FSRS-6
 * approximation, then reuses {@link SrHistoryImporter}'s durable state/log helpers
 * so a migrated card resumes where Anki left it.
 */
export class AnkiHistoryImporter {
  /**
   * Derive an FSRS memory state from one Anki card. Returns null for cards that
   * never graduated (new/learning with no interval) so they stay new in Decks.
   */
  static buildFsrsState(
    scheduling: AnkiScheduling,
    collectionCreatedMs: number | undefined,
    now: Date
  ): FsrsState | null {
    const intervalDays = ivlToDays(scheduling.ivl);
    const hasInterval = intervalDays >= 1;
    const reviewed = scheduling.reps > 0;
    if (!hasInterval && !reviewed) return null;

    const fsrs = AnkiHistoryImporter.extractFsrsBlob(scheduling.data);
    const stability = fsrs?.stability ?? Math.max(intervalDays, 1);
    const difficulty = fsrs?.difficulty ?? AnkiHistoryImporter.easeToDifficulty(scheduling.factor);

    return {
      due: AnkiHistoryImporter.resolveDueMs(scheduling, intervalDays, collectionCreatedMs, now),
      stability: Math.max(stability, 0),
      difficulty: clampDifficulty(difficulty),
      reps: Math.max(scheduling.reps, 1),
      lapses: Math.max(scheduling.lapses, 0),
      intervalDays: Math.max(Math.round(intervalDays), 1),
    };
  }

  // FSRS stability/difficulty live in the cards.data JSON blob (e.g. {"s":4.5,"d":5.1}).
  private static extractFsrsBlob(data: string): { stability: number; difficulty: number } | null {
    if (!data) return null;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") return null;
      const obj = parsed as Record<string, unknown>;
      const s = typeof obj.s === "number" ? obj.s : undefined;
      const d = typeof obj.d === "number" ? obj.d : undefined;
      if (s === undefined && d === undefined) return null;
      return { stability: s ?? 1, difficulty: d ?? 5 };
    } catch {
      return null;
    }
  }

  // SM-2 ease (per-mille factor) → coarse FSRS difficulty bucket, mirroring the
  // SR migrator's mapping. Anki factor 2500 = ease 250.
  private static easeToDifficulty(factor: number): number {
    const ease = factor > 0 ? factor / 10 : 250;
    return ease > 250 ? 3 : ease < 210 ? 8 : 5;
  }

  private static resolveDueMs(
    scheduling: AnkiScheduling,
    intervalDays: number,
    collectionCreatedMs: number | undefined,
    now: Date
  ): number {
    // Learning/relearning store an absolute unix-seconds due.
    if ((scheduling.type === 1 || scheduling.type === 3) && scheduling.due > 1_000_000_000) {
      return scheduling.due * 1000;
    }
    // Review cards store due as a day offset from collection creation.
    if (collectionCreatedMs !== undefined && scheduling.type >= 2) {
      return collectionCreatedMs + scheduling.due * MS_PER_DAY;
    }
    // Fallback: re-anchor the schedule to import time.
    return now.getTime() + intervalDays * MS_PER_DAY;
  }

  /**
   * Inject Anki state, a migration log and the revlog timeline per card; a card
   * reviewed in Decks keeps its state unless Anki answered it later.
   */
  static async importHistory(
    db: AnkiHistoryDb,
    items: AnkiDeckItem[],
    options: AnkiImportHistoryOptions = {},
    now: Date = new Date()
  ): Promise<{ injected: number; reviews: number; kept: number }> {
    let injected = 0;
    let reviews = 0;
    let kept = 0;
    const total = items.reduce((sum, item) => sum + item.cards.length, 0);
    let done = 0;

    for (const item of items) {
      const updates: Array<{ id: string; updates: Partial<Flashcard> }> = [];
      const rows = await AnkiHistoryImporter.readRows(
        db,
        item.cards.map((card) => AnkiHistoryImporter.decksCardId(card))
      );

      for (const card of item.cards) {
        if (++done % 200 === 0) options.onProgress?.(done, total);
        const fsrs = AnkiHistoryImporter.buildFsrsState(card.scheduling, options.collectionCreatedMs, now);
        if (!fsrs) continue;

        const cardId = AnkiHistoryImporter.decksCardId(card);
        const contentHash = generateContentHash(card.back);

        const logId = `log_migrate_anki_${cardId}`;
        if (!(await db.getReviewLogById(logId))) {
          const log = SrHistoryImporter.buildMigrationReviewLog(
            cardId,
            fsrs,
            contentHash,
            item.profileFsrs,
            now
          );
          await db.insertReviewLog({ ...log, id: logId });
          injected++;
        }

        const row = rows.get(cardId);
        const ankiMs = AnkiHistoryImporter.lastAnkiAnswerMs(options.revlogByCard?.get(card.cardId));
        if (row && AnkiHistoryImporter.ankiIsNewer(row, ankiMs)) {
          const update = SrHistoryImporter.buildFlashcardUpdate(fsrs, now);
          if (ankiMs !== null) update.lastReviewed = new Date(ankiMs).toISOString();
          if (!AnkiHistoryImporter.sameState(row, update)) updates.push({ id: cardId, updates: update });
        } else if (row) {
          kept++;
        }

        reviews += await AnkiHistoryImporter.importRevlog(
          db,
          cardId,
          contentHash,
          card,
          item.profileFsrs,
          options.revlogByCard
        );
      }

      if (updates.length) await db.batchUpdateFlashcards(updates);
    }

    options.onProgress?.(total, total);
    return { injected, reviews, kept };
  }

  // By id, not by deck: a card's row may live in another deck its note also feeds.
  private static async readRows(db: AnkiHistoryDb, cardIds: string[]): Promise<Map<string, ImportedRow>> {
    const ids = [...new Set(cardIds)];
    const rows = new Map<string, ImportedRow>();
    for (let i = 0; i < ids.length; i += ROWS_PER_QUERY) {
      const chunk = ids.slice(i, i + ROWS_PER_QUERY);
      for (const row of await db.querySql<ImportedRow>(rowsSql(chunk.length), chunk, { asObject: true })) {
        rows.set(row.id, row);
      }
    }
    return rows;
  }

  // The newest real answer; ease-0 rows are manual reschedules, not reviews.
  private static lastAnkiAnswerMs(revlog: AnkiRevlogRow[] | undefined): number | null {
    let latest: number | null = null;
    for (const row of revlog ?? []) {
      if (row.ease > 0 && (latest === null || row.id > latest)) latest = row.id;
    }
    return latest;
  }

  // Anki's state stands unless Decks reviewed the card later than Anki last answered it.
  private static ankiIsNewer(row: ImportedRow, ankiMs: number | null): boolean {
    if (row.own_reviewed_at === null) return true;
    if (ankiMs === null) return false;
    const decksMs = Math.max(Date.parse(row.last_reviewed ?? "") || 0, Date.parse(row.own_reviewed_at) || 0);
    return ankiMs > decksMs;
  }

  // Unchanged cards are not rewritten, so their modified time stays put.
  private static sameState(row: ImportedRow, update: Partial<Flashcard>): boolean {
    return (
      row.state === update.state &&
      row.due_date === update.dueDate &&
      row.interval === update.interval &&
      row.repetitions === update.repetitions &&
      row.difficulty === update.difficulty &&
      row.stability === update.stability &&
      row.lapses === update.lapses &&
      row.last_reviewed === update.lastReviewed
    );
  }

  private static decksCardId(card: AnkiParsedCard): string {
    // Single source shared with the renderer's anchor bindings, so injected
    // history and emitted tokens always resolve to the same card.
    return AnkiDeckRenderer.decksCardId(card);
  }

  // Best-effort: one ReviewLog per real Anki revlog row. Anki does not store FSRS
  // pre/post state per review, so stability is approximated by each row's own
  // interval (stability ≈ interval at the target retention) — internally
  // consistent and sufficient for the review timeline. Idempotent by row id.
  private static async importRevlog(
    db: HistoryDb,
    cardId: string,
    contentHash: string,
    card: AnkiParsedCard,
    profileFsrs: MigrationProfileFsrs,
    revlogByCard: Map<number, AnkiRevlogRow[]> | undefined
  ): Promise<number> {
    const rows = revlogByCard?.get(card.cardId);
    if (!rows || rows.length === 0) return 0;

    let count = 0;
    const profile = normalizeProfile(profileFsrs.profile);
    for (const row of rows) {
      // A manual reschedule is not an answer; logged, it would outrank later reviews.
      if (row.ease <= 0) continue;
      const logId = `log_anki_${cardId}_${row.id}`;
      if (await db.getReviewLogById(logId)) continue;

      const reviewedAt = new Date(row.id).toISOString();
      const newIntervalDays = ivlToDays(row.ivl);
      const oldIntervalDays = ivlToDays(row.lastIvl);
      const newIntervalMinutes = Math.max(Math.round(newIntervalDays * MINUTES_PER_DAY), 1);
      const oldIntervalMinutes = Math.max(Math.round(oldIntervalDays * MINUTES_PER_DAY), 0);
      const difficulty = clampDifficulty(AnkiHistoryImporter.easeToDifficulty(row.factor));

      const log: ReviewLog = {
        id: logId,
        flashcardId: cardId,
        lastReviewedAt: reviewedAt,
        shownAt: reviewedAt,
        reviewedAt,
        rating: clampRating(row.ease),
        ratingLabel: RATING_LABELS[clampRating(row.ease)],
        timeElapsedMs: 0,

        oldState: oldIntervalDays > 0 ? "review" : "new",
        oldRepetitions: 0,
        oldLapses: 0,
        oldStability: Math.max(oldIntervalDays, 0),
        oldDifficulty: difficulty,

        newState: "review",
        newRepetitions: 1,
        newLapses: 0,
        newStability: Math.max(newIntervalDays, 0),
        newDifficulty: difficulty,

        oldIntervalMinutes,
        newIntervalMinutes,
        oldDueAt: reviewedAt,
        newDueAt: new Date(row.id + newIntervalDays * MS_PER_DAY).toISOString(),

        elapsedDays: Math.max(Math.round(oldIntervalDays), 0),
        retrievability: profileFsrs.requestRetention,

        requestRetention: profileFsrs.requestRetention,
        profile,
        maximumIntervalDays: getMaxIntervalDaysForProfile(profile),
        minMinutes: getMinMinutesForProfile(profile),
        fsrsWeightsVersion: `${profile}-v6`,
        schedulerVersion: "1.0",
        contentHash,
      };
      await db.insertReviewLog(log);
      count++;
    }
    return count;
  }
}
