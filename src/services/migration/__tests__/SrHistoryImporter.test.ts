import { SrHistoryImporter } from "../SrHistoryImporter";
import type { HistoryDb, MigrationDeckItem } from "../SrHistoryImporter";
import type { MigratedCard, FsrsState } from "../LegacySrMigrator";
import type { Flashcard, ReviewLog } from "../../../database/types";
import {
  generateFlashcardId,
  generateReverseFlashcardId,
} from "../../../utils/hash";

const NOW = new Date("2026-06-19T00:00:00.000Z");
const PROFILE = { requestRetention: 0.9, profile: "STANDARD" as const };

function makeDb(): {
  db: HistoryDb;
  logs: ReviewLog[];
  updates: Array<{ id: string; updates: Partial<Flashcard> }>;
} {
  const logs: ReviewLog[] = [];
  const updates: Array<{ id: string; updates: Partial<Flashcard> }> = [];
  const db: HistoryDb = {
    insertReviewLog: async (log) => {
      logs.push(log);
    },
    batchUpdateFlashcards: async (batch) => {
      updates.push(...batch);
    },
    getReviewLogById: async (id) => logs.find((l) => l.id === id) ?? null,
  };
  return { db, logs, updates };
}

const fsrs = (over: Partial<FsrsState> = {}): FsrsState => ({
  due: Date.parse("2026-07-01"),
  stability: 10,
  difficulty: 5,
  reps: 1,
  lapses: 0,
  ...over,
});

const card = (over: Partial<MigratedCard> = {}): MigratedCard => ({
  front: "Front",
  back: "Back",
  tags: [],
  isReverse: false,
  multiline: false,
  suspended: false,
  sourceMatch: "Front :: Back",
  fsrsData: fsrs(),
  ...over,
});

describe("SrHistoryImporter.buildFlashcardUpdate", () => {
  it("converts stability days to interval minutes and sets review state", () => {
    const update = SrHistoryImporter.buildFlashcardUpdate(fsrs({ stability: 10 }), NOW);
    expect(update.state).toBe("review");
    expect(update.interval).toBe(10 * 1440);
    expect(update.repetitions).toBe(1);
    expect(update.lastReviewed).toBe(NOW.toISOString());
  });

  it("clamps difficulty into 1..10 and reps to >= 1", () => {
    const update = SrHistoryImporter.buildFlashcardUpdate(
      fsrs({ difficulty: 99, reps: 0 }),
      NOW
    );
    expect(update.difficulty).toBe(10);
    expect(update.repetitions).toBe(1);
  });
});

describe("SrHistoryImporter.buildMigrationReviewLog", () => {
  it("records new-card defaults as old state and the migrated values as new state", () => {
    const log = SrHistoryImporter.buildMigrationReviewLog(
      "card_x",
      fsrs({ stability: 12.2, difficulty: 4.5, reps: 3, lapses: 1 }),
      "hash",
      PROFILE,
      NOW
    );
    expect(log.oldState).toBe("new");
    expect(log.oldStability).toBe(0);
    expect(log.newState).toBe("review");
    expect(log.newStability).toBeCloseTo(12.2);
    expect(log.newDifficulty).toBeCloseTo(4.5);
    expect(log.newRepetitions).toBe(3);
    expect(log.newLapses).toBe(1);
    expect(log.rating).toBe(3);
    expect(log.ratingLabel).toBe("good");
    expect(log.profile).toBe("STANDARD");
  });
});

describe("SrHistoryImporter.importHistory", () => {
  it("injects forward state keyed by the deterministic card id", async () => {
    const { db, logs, updates } = makeDb();
    const items: MigrationDeckItem[] = [
      { deckId: "deck_1", profileFsrs: PROFILE, cards: [card()] },
    ];
    const { injected } = await SrHistoryImporter.importHistory(db, items, NOW);
    const expectedId = generateFlashcardId("Front", "deck_1");
    expect(injected).toBe(1);
    expect(logs[0].flashcardId).toBe(expectedId);
    expect(logs[0].id).toBe(`log_migrate_${expectedId}`);
    expect(updates[0].id).toBe(expectedId);
  });

  it("injects independent forward and reverse state with distinct log ids", async () => {
    const { db, logs } = makeDb();
    const reverseCard = card({
      isReverse: true,
      fsrsData: fsrs({ stability: 5 }),
      fsrsDataReverse: fsrs({ stability: 50 }),
    });
    const items: MigrationDeckItem[] = [
      { deckId: "deck_1", profileFsrs: PROFILE, cards: [reverseCard] },
    ];
    await SrHistoryImporter.importHistory(db, items, NOW);

    const fwdId = generateFlashcardId("Front", "deck_1");
    const revId = generateReverseFlashcardId("Front", "deck_1");
    const fwdLog = logs.find((l) => l.flashcardId === fwdId)!;
    const revLog = logs.find((l) => l.flashcardId === revId)!;
    expect(fwdLog.id).toBe(`log_migrate_${fwdId}`);
    expect(revLog.id).toBe(`log_migrate_${revId}`);
    expect(fwdLog.newStability).toBe(5);
    expect(revLog.newStability).toBe(50);
  });

  it("skips cards without fsrs data", async () => {
    const { db, logs } = makeDb();
    const items: MigrationDeckItem[] = [
      { deckId: "deck_1", profileFsrs: PROFILE, cards: [card({ fsrsData: undefined })] },
    ];
    const { injected } = await SrHistoryImporter.importHistory(db, items, NOW);
    expect(injected).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it("suspends a card with history: review state + suspendedAt, plus a log", async () => {
    const { db, logs, updates } = makeDb();
    const items: MigrationDeckItem[] = [
      { deckId: "deck_1", profileFsrs: PROFILE, cards: [card({ suspended: true })] },
    ];
    const { injected, suspended } = await SrHistoryImporter.importHistory(db, items, NOW);
    expect(injected).toBe(1);
    expect(suspended).toBe(1);
    expect(logs).toHaveLength(1);
    expect(updates[0].updates.state).toBe("review");
    expect(updates[0].updates.suspendedAt).toBe(NOW.toISOString());
  });

  it("suspends a no-history card: suspendedAt only, state stays new, no log", async () => {
    const { db, logs, updates } = makeDb();
    const items: MigrationDeckItem[] = [
      {
        deckId: "deck_1",
        profileFsrs: PROFILE,
        cards: [card({ fsrsData: undefined, suspended: true })],
      },
    ];
    const { injected, suspended } = await SrHistoryImporter.importHistory(db, items, NOW);
    expect(injected).toBe(0);
    expect(suspended).toBe(1);
    expect(logs).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].updates.suspendedAt).toBe(NOW.toISOString());
    expect(updates[0].updates.state).toBeUndefined();
  });

  it("uses deterministic log ids so re-runs are idempotent", async () => {
    const a = makeDb();
    const b = makeDb();
    const items: MigrationDeckItem[] = [
      { deckId: "deck_1", profileFsrs: PROFILE, cards: [card()] },
    ];
    await SrHistoryImporter.importHistory(a.db, items, NOW);
    await SrHistoryImporter.importHistory(b.db, items, NOW);
    expect(a.logs[0].id).toBe(b.logs[0].id);
  });
});
