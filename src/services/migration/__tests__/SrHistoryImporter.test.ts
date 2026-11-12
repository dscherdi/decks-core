import { SrHistoryImporter } from "../SrHistoryImporter";
import type { HistoryDb, MigrationDeckItem } from "../SrHistoryImporter";
import { LegacySrMigrator } from "../LegacySrMigrator";
import type { MigratedCard, FsrsState } from "../LegacySrMigrator";
import type { Flashcard, ReviewLog } from "../../../database/types";
import type { SqlJsValue } from "../../../database/sql-types";
import {
  generateClozeFlashcardId,
  generateFlashcardId,
  generateReverseFlashcardId,
} from "../../../utils/hash";

const NOW = new Date("2026-06-19T00:00:00.000Z");
const PROFILE = { requestRetention: 0.9, profile: "STANDARD" as const };

const isImported = (logId: string): boolean =>
  logId.startsWith("log_anki_") || logId.startsWith("log_migrate_");

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
    // Answers the importer's one query: a card's Decks reviews newer than a given time.
    querySql: <T>(_sql: string, params: SqlJsValue[] = []): Promise<T[]> => {
      const [cardId, since] = params;
      const own = logs.filter(
        (l) =>
          l.flashcardId === cardId &&
          !isImported(l.id) &&
          typeof since === "string" &&
          l.reviewedAt > since
      );
      return Promise.resolve(own.map(() => [1]) as T[]);
    },
  };
  return { db, logs, updates };
}

// A review made in Decks: its log id carries no importer prefix.
function reviewInDecks(logs: ReviewLog[], cardId: string, at: Date): void {
  logs.push({
    ...SrHistoryImporter.buildMigrationReviewLog(cardId, fsrs(), "hash", PROFILE, at),
    id: `log_${at.getTime()}_x`,
    reviewedAt: at.toISOString(),
  });
}

const fsrs = (over: Partial<FsrsState> = {}): FsrsState => ({
  due: Date.parse("2026-07-01"),
  stability: 10,
  difficulty: 5,
  reps: 1,
  lapses: 0,
  intervalDays: 10,
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

  it("backdates lastReviewed to due − interval for a past review", () => {
    const update = SrHistoryImporter.buildFlashcardUpdate(
      fsrs({ due: Date.parse("2024-06-18"), intervalDays: 12 }),
      NOW
    );
    // 2024-06-18 minus 12 days = 2024-06-06, well before NOW.
    expect(update.lastReviewed).toBe(new Date(Date.parse("2024-06-06")).toISOString());
    // The due date itself is preserved as the parsed SR due.
    expect(update.dueDate).toBe(new Date(Date.parse("2024-06-18")).toISOString());
  });

  it("clamps the backdated review so it never lands in the future", () => {
    // A future due with a small interval would imply a future review date.
    const update = SrHistoryImporter.buildFlashcardUpdate(
      fsrs({ due: Date.parse("2026-07-01"), intervalDays: 2 }),
      NOW
    );
    expect(update.lastReviewed).toBe(NOW.toISOString());
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
    const expectedId = generateFlashcardId("Front");
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

    const fwdId = generateFlashcardId("Front");
    const revId = generateReverseFlashcardId("Front");
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

  it("injects each cloze under its generateClozeFlashcardId", async () => {
    const { db, logs, updates } = makeDb();
    const clozeCard: MigratedCard = {
      front: "Geo",
      back: "The capital is ==Paris== in ==France==.",
      tags: [],
      isReverse: false,
      multiline: true,
      suspended: false,
      sourceMatch: "",
      clozes: [
        { clozeText: "Paris", clozeOrder: 0, fsrsData: fsrs({ stability: 4 }) },
        { clozeText: "France", clozeOrder: 1, fsrsData: fsrs({ stability: 9 }) },
      ],
    };
    const items: MigrationDeckItem[] = [
      { deckId: "deck_1", profileFsrs: PROFILE, cards: [clozeCard] },
    ];
    const { injected } = await SrHistoryImporter.importHistory(db, items, NOW);
    expect(injected).toBe(2);
    const id0 = generateClozeFlashcardId("Geo", "Paris", 0);
    const id1 = generateClozeFlashcardId("Geo", "France", 1);
    expect(logs.map((l) => l.flashcardId).sort()).toEqual([id0, id1].sort());
    expect(updates.find((u) => u.id === id0)!.updates.stability).toBe(4);
    expect(updates.find((u) => u.id === id1)!.updates.stability).toBe(9);
  });

  it("suspends every cloze of a suspended cloze block", async () => {
    const { db, updates } = makeDb();
    const clozeCard: MigratedCard = {
      front: "Geo",
      back: "==Paris==",
      tags: [],
      isReverse: false,
      multiline: true,
      suspended: true,
      sourceMatch: "",
      clozes: [{ clozeText: "Paris", clozeOrder: 0, fsrsData: fsrs() }],
    };
    await SrHistoryImporter.importHistory(
      db,
      [{ deckId: "deck_1", profileFsrs: PROFILE, cards: [clozeCard] }],
      NOW
    );
    const id = generateClozeFlashcardId("Geo", "Paris", 0);
    expect(updates.find((u) => u.id === id)!.updates.suspendedAt).toBe(NOW.toISOString());
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

  it("writes as many logs as countCards reports schedules", async () => {
    const { db } = makeDb();
    const cards: MigratedCard[] = [
      card(),
      card({ front: "Cat", isReverse: true, fsrsDataReverse: fsrs() }),
      card({ front: "No history", fsrsData: undefined }),
      card({
        front: "The ==sun== is a ==star==.",
        back: "",
        fsrsData: undefined,
        clozes: [
          { clozeText: "sun", clozeOrder: 0, fsrsData: fsrs() },
          { clozeText: "star", clozeOrder: 1 },
        ],
      }),
    ];
    const { injected } = await SrHistoryImporter.importHistory(
      db,
      [{ deckId: "deck_1", profileFsrs: PROFILE, cards }],
      NOW
    );
    expect(LegacySrMigrator.countCards(cards)).toEqual({ cards: 6, withHistory: injected });
    expect(injected).toBe(4);
  });
});

describe("SrHistoryImporter.importHistory on a re-run", () => {
  const REVIEWED = new Date("2026-06-25T00:00:00.000Z");
  const RERUN = new Date("2026-07-10T00:00:00.000Z");
  const cardId = generateFlashcardId("Front");
  const deck = (cards: MigratedCard[]): MigrationDeckItem[] => [
    { deckId: "deck_1", profileFsrs: PROFILE, cards },
  ];

  it("keeps the state of a card reviewed in Decks since it was migrated", async () => {
    const { db, logs, updates } = makeDb();
    await SrHistoryImporter.importHistory(db, deck([card()]), NOW);
    reviewInDecks(logs, cardId, REVIEWED);
    const firstRun = updates.length;

    const { injected } = await SrHistoryImporter.importHistory(db, deck([card()]), RERUN);

    expect(injected).toBe(0);
    expect(updates.slice(firstRun)).toEqual([]);
    expect(logs).toHaveLength(2);
  });

  it("gives a card never reviewed in Decks its legacy state again", async () => {
    const { db, updates } = makeDb();
    await SrHistoryImporter.importHistory(db, deck([card()]), NOW);
    const firstRun = updates.length;

    const { injected } = await SrHistoryImporter.importHistory(db, deck([card()]), RERUN);

    expect(injected).toBe(0);
    const rerun = updates.slice(firstRun);
    expect(rerun).toHaveLength(1);
    expect(rerun[0].id).toBe(cardId);
    expect(rerun[0].updates.state).toBe("review");
    expect(rerun[0].updates.stability).toBe(10);
  });

  it("gives the legacy state again when the Decks review is older than the migration log", async () => {
    const { db, logs, updates } = makeDb();
    reviewInDecks(logs, cardId, new Date("2026-06-01T00:00:00.000Z"));
    await SrHistoryImporter.importHistory(db, deck([card()]), NOW);
    const firstRun = updates.length;

    await SrHistoryImporter.importHistory(db, deck([card()]), RERUN);

    expect(updates.slice(firstRun).map((u) => u.updates.state)).toEqual(["review"]);
  });

  it("still suspends a #sr-skip card reviewed in Decks, leaving its state alone", async () => {
    const { db, logs, updates } = makeDb();
    const skipped = deck([card({ suspended: true })]);
    await SrHistoryImporter.importHistory(db, skipped, NOW);
    reviewInDecks(logs, cardId, REVIEWED);
    const firstRun = updates.length;

    const { suspended } = await SrHistoryImporter.importHistory(db, skipped, RERUN);

    expect(suspended).toBe(1);
    expect(updates.slice(firstRun)).toEqual([
      { id: cardId, updates: { suspendedAt: RERUN.toISOString() } },
    ]);
  });

  it("judges each direction of a reversed card on its own", async () => {
    const { db, logs, updates } = makeDb();
    const reversed = deck([card({ isReverse: true, fsrsDataReverse: fsrs({ stability: 50 }) })]);
    await SrHistoryImporter.importHistory(db, reversed, NOW);
    reviewInDecks(logs, generateReverseFlashcardId("Front"), REVIEWED);
    const firstRun = updates.length;

    await SrHistoryImporter.importHistory(db, reversed, RERUN);

    expect(updates.slice(firstRun).map((u) => u.id)).toEqual([cardId]);
  });
});
