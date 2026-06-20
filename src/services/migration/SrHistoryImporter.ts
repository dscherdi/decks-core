import type { IDatabaseService } from "../../database/DatabaseService.interface";
import type { Flashcard, ReviewLog } from "../../database/types";
import type { FSRSProfile } from "../../algorithm/fsrs-weights";
import {
  getMaxIntervalDaysForProfile,
  getMinMinutesForProfile,
  normalizeProfile,
} from "../../algorithm/fsrs-weights";
import {
  generateClozeFlashcardId,
  generateContentHash,
  generateFlashcardId,
  generateReverseFlashcardId,
} from "../../utils/hash";
import type { FsrsState, MigratedCard } from "./LegacySrMigrator";

const MINUTES_PER_DAY = 1440;

/** The slice of the database interface the importer needs. */
export type HistoryDb = Pick<
  IDatabaseService,
  "insertReviewLog" | "batchUpdateFlashcards" | "getReviewLogById"
>;

export interface MigrationProfileFsrs {
  requestRetention: number;
  profile: FSRSProfile;
}

export interface MigrationDeckItem {
  deckId: string;
  profileFsrs: MigrationProfileFsrs;
  cards: MigratedCard[];
}

function clampDifficulty(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, value));
}

function intervalMinutes(stabilityDays: number): number {
  return Math.max(1, Math.round(stabilityDays * MINUTES_PER_DAY));
}

const MS_PER_DAY = 86_400_000;

// The implied last-review date is `due − interval` (SR stores due + interval but
// not the review timestamp). Clamp so it never lands in the future.
function reviewedTimestamp(fsrs: FsrsState, now: Date): string {
  const reviewedMs = Math.min(fsrs.due - fsrs.intervalDays * MS_PER_DAY, now.getTime());
  return new Date(reviewedMs).toISOString();
}

/**
 * Builds the durable FSRS state + a synthetic review log so a migrated card
 * resumes where the legacy plugin left it. Pure: takes the injected database
 * service interface, so it is testable in-process.
 */
export class SrHistoryImporter {
  static buildFlashcardUpdate(fsrs: FsrsState, now: Date): Partial<Flashcard> {
    return {
      state: "review",
      dueDate: new Date(fsrs.due).toISOString(),
      interval: intervalMinutes(fsrs.stability),
      repetitions: Math.max(fsrs.reps, 1),
      difficulty: clampDifficulty(fsrs.difficulty),
      stability: Math.max(fsrs.stability, 0),
      lapses: Math.max(fsrs.lapses, 0),
      lastReviewed: reviewedTimestamp(fsrs, now),
    };
  }

  static buildMigrationReviewLog(
    cardId: string,
    fsrs: FsrsState,
    contentHash: string,
    profileFsrs: MigrationProfileFsrs,
    now: Date
  ): Omit<ReviewLog, "id"> {
    const profile = normalizeProfile(profileFsrs.profile);
    const reviewedIso = reviewedTimestamp(fsrs, now);
    return {
      flashcardId: cardId,
      sessionId: undefined,
      lastReviewedAt: reviewedIso,
      shownAt: reviewedIso,
      reviewedAt: reviewedIso,
      rating: 3,
      ratingLabel: "good",
      timeElapsedMs: 0,

      oldState: "new",
      oldRepetitions: 0,
      oldLapses: 0,
      oldStability: 0,
      oldDifficulty: 5,

      newState: "review",
      newRepetitions: Math.max(fsrs.reps, 1),
      newLapses: Math.max(fsrs.lapses, 0),
      newStability: Math.max(fsrs.stability, 0),
      newDifficulty: clampDifficulty(fsrs.difficulty),

      oldIntervalMinutes: 0,
      newIntervalMinutes: intervalMinutes(fsrs.stability),
      oldDueAt: reviewedIso,
      newDueAt: new Date(fsrs.due).toISOString(),

      elapsedDays: 0,
      retrievability: profileFsrs.requestRetention,

      requestRetention: profileFsrs.requestRetention,
      profile,
      maximumIntervalDays: getMaxIntervalDaysForProfile(profile),
      minMinutes: getMinMinutesForProfile(profile),
      fsrsWeightsVersion: `${profile}-v6`,
      schedulerVersion: "1.0",
      contentHash,
    };
  }

  /**
   * Injects history for already-synced cards. For each direction the log is
   * written first (durable; drives Smart Restoration on any later re-sync),
   * then the live card state is updated so the schedule is effective at once.
   */
  static async importHistory(
    db: HistoryDb,
    items: MigrationDeckItem[],
    now: Date = new Date()
  ): Promise<{ injected: number; suspended: number }> {
    let injected = 0;
    let suspended = 0;
    for (const item of items) {
      const updates: Array<{ id: string; updates: Partial<Flashcard> }> = [];

      for (const card of item.cards) {
        if (card.clozes) {
          // One Decks cloze card per highlight; state[i] → clozeOrder i.
          for (const cloze of card.clozes) {
            const id = generateClozeFlashcardId(
              card.front,
              cloze.clozeText,
              cloze.clozeOrder,
              item.deckId
            );
            const res = await SrHistoryImporter.injectDirection(
              db,
              id,
              cloze.fsrsData,
              generateContentHash(card.back),
              card.suspended,
              item.profileFsrs,
              now,
              updates
            );
            injected += res.injected;
            suspended += res.suspended;
          }
          continue;
        }

        const cardId = generateFlashcardId(card.front, item.deckId);
        const fwd = await SrHistoryImporter.injectDirection(
          db,
          cardId,
          card.fsrsData,
          generateContentHash(card.back),
          card.suspended,
          item.profileFsrs,
          now,
          updates
        );
        injected += fwd.injected;
        suspended += fwd.suspended;

        if (card.isReverse) {
          const reverseId = generateReverseFlashcardId(card.front, item.deckId);
          const rev = await SrHistoryImporter.injectDirection(
            db,
            reverseId,
            card.fsrsDataReverse,
            generateContentHash(card.front),
            card.suspended,
            item.profileFsrs,
            now,
            updates
          );
          injected += rev.injected;
          suspended += rev.suspended;
        }
      }

      if (updates.length) {
        await db.batchUpdateFlashcards(updates);
      }
    }
    return { injected, suspended };
  }

  // Queues one direction's state update (and writes its review log when there's
  // history). The synthetic log id is deterministic, so a previously-migrated
  // card is left untouched (the local insert path is a plain INSERT and would
  // otherwise collide). Suspension is applied with or without history.
  private static async injectDirection(
    db: HistoryDb,
    cardId: string,
    fsrs: FsrsState | undefined,
    contentHash: string,
    suspend: boolean,
    profileFsrs: MigrationProfileFsrs,
    now: Date,
    updates: Array<{ id: string; updates: Partial<Flashcard> }>
  ): Promise<{ injected: number; suspended: number }> {
    if (fsrs) {
      const logId = `log_migrate_${cardId}`;
      const isNew = !(await db.getReviewLogById(logId));
      if (isNew) {
        const log = SrHistoryImporter.buildMigrationReviewLog(
          cardId,
          fsrs,
          contentHash,
          profileFsrs,
          now
        );
        await db.insertReviewLog({ ...log, id: logId });
      }
      const update = SrHistoryImporter.buildFlashcardUpdate(fsrs, now);
      if (suspend) update.suspendedAt = now.toISOString();
      updates.push({ id: cardId, updates: update });
      return { injected: isNew ? 1 : 0, suspended: suspend ? 1 : 0 };
    }

    if (suspend) {
      // No history — just freeze the (otherwise new) card.
      updates.push({ id: cardId, updates: { suspendedAt: now.toISOString() } });
      return { injected: 0, suspended: 1 };
    }

    return { injected: 0, suspended: 0 };
  }
}
