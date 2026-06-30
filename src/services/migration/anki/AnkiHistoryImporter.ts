import type { Flashcard, ReviewLog } from "../../../database/types";
import {
  getMaxIntervalDaysForProfile,
  getMinMinutesForProfile,
  normalizeProfile,
} from "../../../algorithm/fsrs-weights";
import {
  generateClozeFlashcardId,
  generateContentHash,
  generateFlashcardId,
  generateOcclusionV2FlashcardId,
} from "../../../utils/hash";
import { splitClozeHeader } from "./ClozeLayout";
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
   * Inject state + a synthetic migration log for every card (drives Smart
   * Restoration), plus the real Anki review rows as a timeline when provided.
   */
  static async importHistory(
    db: HistoryDb,
    items: AnkiDeckItem[],
    options: AnkiImportHistoryOptions = {},
    now: Date = new Date()
  ): Promise<{ injected: number; reviews: number }> {
    let injected = 0;
    let reviews = 0;
    const total = items.reduce((sum, item) => sum + item.cards.length, 0);
    let done = 0;

    for (const item of items) {
      const updates: Array<{ id: string; updates: Partial<Flashcard> }> = [];

      for (const card of item.cards) {
        if (++done % 200 === 0) options.onProgress?.(done, total);
        const fsrs = AnkiHistoryImporter.buildFsrsState(card.scheduling, options.collectionCreatedMs, now);
        if (!fsrs) continue;

        const cardId = AnkiHistoryImporter.decksCardId(card, item.deckId);
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

        updates.push({ id: cardId, updates: SrHistoryImporter.buildFlashcardUpdate(fsrs, now) });

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
    return { injected, reviews };
  }

  private static decksCardId(card: AnkiParsedCard, deckId: string): string {
    if (card.kind === "occlusion" && card.imagePath && card.maskId) {
      return generateOcclusionV2FlashcardId(deckId, card.imagePath, card.maskId);
    }
    if (card.isCloze) {
      // The parser hashes the rendered front: a compact cloze stays a table cell
      // (front = the whole sentence); a multi-paragraph one becomes header-
      // paragraph (front = the title line). The leading line carries no highlight,
      // so cloze order/text are unchanged either way.
      const full = (card.clozeBody ?? card.back).trim();
      const split = splitClozeHeader(full);
      const front = split ? split.header : full;
      return generateClozeFlashcardId(
        front,
        card.clozeText ?? "",
        card.clozeOrder ?? card.ord,
        deckId
      );
    }
    return generateFlashcardId(card.front, deckId);
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
