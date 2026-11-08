import { Scheduler } from "../../services/Scheduler";
import { applyOp } from "../../services/SyncLog.handlers";
import { DEFAULT_SETTINGS } from "../../settings";
import type {
  DeckProfile,
  FileDeck,
  Flashcard,
  IDatabaseService,
  ILogger,
  ISyncLog,
  ProfileUpsertOp,
  SyncLogEntry,
  SyncOpV1,
} from "../../index";
import { type ConformanceHost, testDeck } from "./harness";

const NOTE = "## Body\n\nThe ==heart== pumps ==blood==.\nThe ==lungs== take in ==air==.\n";
const quiet: ILogger = { debug: () => {}, error: () => {} };

function ids(cards: readonly Flashcard[]): string[] {
  return cards.map((card) => card.id);
}

function upsertEntry(profile: DeckProfile, changes: Partial<ProfileUpsertOp["p"]>): SyncLogEntry {
  const p: ProfileUpsertOp["p"] = {
    id: profile.id,
    name: profile.name,
    hasNewCardsLimitEnabled: profile.hasNewCardsLimitEnabled,
    newCardsPerDay: profile.newCardsPerDay,
    hasReviewCardsLimitEnabled: profile.hasReviewCardsLimitEnabled,
    reviewCardsPerDay: profile.reviewCardsPerDay,
    headerLevel: profile.headerLevel,
    reviewOrder: profile.reviewOrder,
    learningSteps: profile.learningSteps,
    relearningSteps: profile.relearningSteps,
    fsrsRequestRetention: profile.fsrs.requestRetention,
    fsrsProfile: profile.fsrs.profile,
    clozeEnabled: profile.clozeEnabled,
    clozeShowContext: profile.clozeShowContext,
    isDefault: profile.isDefault,
    created: profile.created,
    modified: "2099-01-01T00:00:00.000Z",
    ...changes,
  };
  const op: ProfileUpsertOp = { o: "profile_upsert", p };
  return { hlc: [Date.parse(p.modified), 0, "remote-dev"], s: 1, v: 1, ...op };
}

/** Clozes on one line are shown, rated and undone together, while each stays its own card. */
export function describeClozeLineGroups(host: ConformanceHost): void {
  describe(`cloze line groups (${host.label})`, () => {
    let db: IDatabaseService;
    let scheduler: Scheduler;
    let deckId: string;
    let profileId: string;
    let syncOps: SyncOpV1[];

    async function cards(): Promise<Flashcard[]> {
      const all = await db.getFlashcardsByDeck(deckId);
      return all.sort((a, b) => (a.clozeOrder ?? 0) - (b.clozeOrder ?? 0));
    }

    async function logs(): Promise<{ flashcard_id: string; time_elapsed_ms: number }[]> {
      return await db.querySql<{ flashcard_id: string; time_elapsed_ms: number }>(
        "SELECT flashcard_id, time_elapsed_ms FROM review_logs ORDER BY flashcard_id",
        [],
        { asObject: true }
      );
    }

    async function syncNote(content: string): Promise<void> {
      const deck = await db.getDeckWithProfile(deckId);
      if (!deck) throw new Error("deck missing");
      await db.syncFlashcardsForDeck({
        deckId,
        deckName: deck.name,
        deckFilepath: deck.filepath,
        deckConfig: deck.profile,
        fileContent: content,
        clozeEnabled: true,
      });
    }

    async function setGrouped(on: boolean, extra: Partial<DeckProfile> = {}): Promise<void> {
      await db.updateProfile(profileId, { clozeGroupByLine: on, ...extra });
    }

    beforeEach(async () => {
      db = await host.open();
      deckId = await db.createDeck(testDeck({ filepath: "/test/cloze-lines.md" }));
      const deck = await db.getDeckWithProfile(deckId);
      if (!deck) throw new Error("deck missing");
      profileId = deck.profile.id;
      await setGrouped(true, { clozeEnabled: true });
      await syncNote(NOTE);
      expect(await cards()).toHaveLength(4);

      scheduler = new Scheduler(db, DEFAULT_SETTINGS, { createBackup: async () => undefined });
      syncOps = [];
      const syncLog: ISyncLog = { append: (op) => syncOps.push(op) };
      scheduler.setSyncLog(syncLog);
    });
    afterEach(async () => {
      await host.close(db);
    });

    it("keeps the setting on the profile and in its sync op", async () => {
      const stored = await db.getProfileById(profileId);
      expect(stored?.clozeGroupByLine).toBe(true);
      if (!stored) return;

      // An op from a client that predates the field keeps the stored value.
      await applyOp(db, "remote-dev", upsertEntry(stored, {}), quiet);
      expect((await db.getProfileById(profileId))?.clozeGroupByLine).toBe(true);

      const later = { clozeGroupByLine: false, modified: "2099-01-02T00:00:00.000Z" };
      await applyOp(db, "remote-dev", upsertEntry(stored, later), quiet);
      expect((await db.getProfileById(profileId))?.clozeGroupByLine).toBe(false);
    });

    it("makes a step of each line, and one per cloze when off", async () => {
      const [heart, blood, lungs, air] = await cards();
      const steps = await scheduler.getClozeSteps(heart, new Date());
      expect(steps.map((step) => ids(step.cards))).toEqual([
        [heart.id, blood.id],
        [lungs.id, air.id],
      ]);
      expect(steps.map((step) => step.activeOrders)).toEqual([
        [0, 1],
        [2, 3],
      ]);

      await setGrouped(false);
      const separate = await scheduler.getClozeSteps(heart, new Date());
      expect(separate.map((step) => ids(step.cards))).toEqual([[heart.id], [blood.id], [lungs.id], [air.id]]);
      expect(separate.map((step) => step.activeOrders)).toEqual([[0], [1], [2], [3]]);
    });

    it("rates each card of a line on its own, with its own log, sync op and session count", async () => {
      const now = new Date();
      const { sessionId } = await scheduler.startFreshSession(deckId, now);
      const [heart, blood, lungs] = await cards();

      const rated = await scheduler.rateGroup([heart, blood], "good", 6000, now);
      expect(ids(rated)).toEqual([heart.id, blood.id]);

      const after = await cards();
      expect(after.map((card) => card.state)).toEqual(["review", "review", "new", "new"]);
      expect(ids(after)).toEqual([heart.id, blood.id, lungs.id, after[3].id]);
      expect(after[2]).toEqual(lungs);

      const written = await logs();
      expect(written.map((log) => log.flashcard_id).sort()).toEqual([heart.id, blood.id].sort());
      expect(written.map((log) => log.time_elapsed_ms)).toEqual([3000, 3000]);

      const rates = syncOps.filter((op) => op.o === "rate");
      expect(rates).toHaveLength(2);
      expect(new Set(rates.map((op) => (op.o === "rate" ? op.p.log.id : ""))).size).toBe(2);

      expect((await scheduler.getSessionProgress(sessionId))?.doneUnique).toBe(2);
      expect((await db.getDailyReviewCounts(deckId, DEFAULT_SETTINGS.review.nextDayStartsAt)).newCount).toBe(2);
    });

    it("undoes a line's rating whole, after any rating made since", async () => {
      const now = new Date();
      const { sessionId } = await scheduler.startFreshSession(deckId, now);
      const [heart, blood, lungs] = await cards();
      await scheduler.rateGroup([heart, blood], "good", 2000, now);
      await scheduler.rate(lungs, "easy");

      expect((await scheduler.undoLastReview())?.id).toBe(lungs.id);
      expect((await cards()).map((card) => card.state)).toEqual(["review", "review", "new", "new"]);

      expect(ids(await scheduler.undoLastReviewGroup())).toEqual([heart.id, blood.id]);
      const restored = await cards();
      for (const [index, card] of [heart, blood, lungs].entries()) {
        expect(restored[index]).toMatchObject({
          id: card.id,
          state: card.state,
          dueDate: card.dueDate,
          stability: card.stability,
          difficulty: card.difficulty,
          repetitions: card.repetitions,
        });
      }
      expect(await logs()).toEqual([]);
      expect((await scheduler.getSessionProgress(sessionId))?.doneUnique).toBe(0);
      expect(await scheduler.hasUndoableReview()).toBe(false);
      expect(syncOps.filter((op) => op.o === "rate_undo")).toHaveLength(3);
    });

    it("counts every card of a line against the new-card limit", async () => {
      await setGrouped(true, { hasNewCardsLimitEnabled: true, newCardsPerDay: 2 });
      const now = new Date();
      await scheduler.startFreshSession(deckId, now);
      const [heart, blood] = await cards();
      await scheduler.rateGroup([heart, blood], "good", undefined, now);
      expect(await scheduler.getNext(new Date(), deckId)).toBeNull();
    });

    it("brings a line rated Again back as one step", async () => {
      const now = new Date();
      await scheduler.startFreshSession(deckId, now);
      const [heart, blood] = await cards();
      await scheduler.rateGroup([heart, blood], "again", undefined, now);

      const [heartAgain] = await cards();
      expect(new Date(heartAgain.dueDate).getTime()).toBeGreaterThan(now.getTime());
      const [first] = await scheduler.getClozeSteps(heartAgain, now);
      expect(ids(first.cards)).toEqual([heart.id, blood.id]);
    });

    it("drills a line as one in cram and undoes it whole, touching no real state", async () => {
      const all = await cards();
      const deck = await db.getDeckWithProfile(deckId);
      if (!deck) throw new Error("deck missing");
      const target: FileDeck = { ...deck, type: "file" };
      const { sessionId } = await scheduler.startCramSession(target, all, new Date());
      const [heart, blood, lungs] = all;

      const step = await scheduler.getCramClozeStep(sessionId, heart);
      expect(ids(step.cards)).toEqual([heart.id, blood.id]);
      expect(step.activeOrders).toEqual([0, 1]);

      await scheduler.rateCramGroup(sessionId, ids(step.cards), "again", new Date());
      for (const card of [heart, blood]) {
        expect((await db.getCramCardById(`${sessionId}:${card.id}`))?.reps).toBe(1);
      }
      expect((await db.getCramCardById(`${sessionId}:${lungs.id}`))?.reps).toBe(0);

      expect(ids(await scheduler.undoLastCramGroup(sessionId))).toEqual([heart.id, blood.id]);
      for (const card of [heart, blood]) {
        expect((await db.getCramCardById(`${sessionId}:${card.id}`))?.reps).toBe(0);
      }
      expect(scheduler.hasUndoableCram(sessionId)).toBe(false);
      expect(await logs()).toEqual([]);
      expect(syncOps).toEqual([]);
      expect(await cards()).toEqual(all);
    });

    it("keeps every card id when the setting changes", async () => {
      const before = ids(await cards());
      await setGrouped(false);
      await syncNote(NOTE);
      expect(ids(await cards())).toEqual(before);
      await setGrouped(true);
      await syncNote(NOTE);
      expect(ids(await cards())).toEqual(before);
    });
  });
}
