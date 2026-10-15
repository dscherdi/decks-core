import initSqlJs, { type Database } from "sql.js";
import { CREATE_TABLES_SQL } from "../../database/schemas";
import { DEFAULT_DECK_PROFILE, DEFAULT_PROFILE_ID } from "../../database/types";
import type { IDatabaseService } from "../../database/DatabaseService.interface";
import type { SqlJsValue } from "../../database/sql-types";
import { generateContentHash, generateFlashcardId } from "../../utils/hash";
import { FlashcardSynchronizer } from "../FlashcardSynchronizer";
import { applyOp } from "../SyncLog.handlers";
import type { SyncLogEntry } from "../SyncLog.types";
import { forgetStrandedHistory, recoverReviewHistory, relinkCardHistory } from "../ReviewHistoryRecovery";

const NOW = "2026-10-10T00:00:00.000Z";
const BACK = "The powerhouse of the cell, where respiration happens.";
const LIVE = generateFlashcardId("Mitochondria");
const TRANSACTION = /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** Runs SQL on a real database and keeps every statement it was handed. */
class RecordingDb {
  readonly statements: string[] = [];

  constructor(private readonly db: Database, private readonly failing: RegExp | null = null) {}

  async querySql<T>(sql: string, params: SqlJsValue[] = []): Promise<T[]> {
    this.record(sql);
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  async executeSql(sql: string, params: SqlJsValue[] = []): Promise<void> {
    this.record(sql);
    this.db.run(sql, params);
  }

  private record(sql: string): void {
    this.statements.push(sql);
    if (this.failing?.test(sql)) throw new Error("statement failed");
  }
}

let sqlite: Database;

beforeEach(async () => {
  const SQL = await initSqlJs();
  sqlite = new SQL.Database();
  sqlite.run(CREATE_TABLES_SQL);
  sqlite.run(
    "INSERT INTO decks (id, name, filepath, tag, profile_id, created, modified) VALUES ('deck_a1', 'A', 'A.md', '#decks', ?, ?, ?)",
    [DEFAULT_PROFILE_ID, NOW, NOW]
  );
  new FlashcardSynchronizer(sqlite).syncFlashcardsForDeck({
    deckId: "deck_a1",
    deckName: "A",
    deckFilepath: "A.md",
    deckConfig: { ...DEFAULT_DECK_PROFILE, id: DEFAULT_PROFILE_ID, created: NOW, modified: NOW },
    fileContent: `## Mitochondria\n\n${BACK}\n`,
  });
  sqlite.run(
    `INSERT INTO review_logs (id, flashcard_id, last_reviewed_at, reviewed_at, rating, rating_label,
       old_state, new_state, new_stability, old_interval_minutes, new_interval_minutes, old_due_at,
       new_due_at, elapsed_days, retrievability, request_retention, maximum_interval_days,
       min_minutes, fsrs_weights_version, scheduler_version, content_hash)
     VALUES ('log_1', 'card_dead', ?, ?, 3, 'good', 'new', 'review', 7, 0, 4320, ?, ?, 0, 1, 0.9, 36500, 1, 'test', 'test', ?)`,
    ["2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z", NOW, NOW, generateContentHash(BACK)]
  );
});

afterEach(() => sqlite.close());

function logsOf(cardId: string): number {
  return sqlite.exec("SELECT COUNT(*) FROM review_logs WHERE flashcard_id = ?", [cardId])[0].values[0][0] as number;
}

describe("review history recovery", () => {
  it("runs without transaction statements", async () => {
    const db = new RecordingDb(sqlite);

    const result = await recoverReviewHistory(db, { contentMatch: true, now: NOW });
    await forgetStrandedHistory(db, [LIVE], NOW);

    expect(result.reattached).toBe(1);
    expect(db.statements.filter((sql) => TRANSACTION.test(sql))).toEqual([]);
  });

  it("still moves the reviews when a dependent table is missing", async () => {
    sqlite.run("DROP TABLE exam_answers");

    const moved = await relinkCardHistory(new RecordingDb(sqlite), { from: "card_dead", to: LIVE }, NOW);

    expect(moved).toBe(1);
    expect(logsOf(LIVE)).toBe(1);
  });

  it("a history_relink whose statements fail does not throw", async () => {
    const db = new RecordingDb(sqlite, /review_logs/);
    const entry: SyncLogEntry = {
      hlc: [Date.parse(NOW), 0, "remote-dev"],
      s: 1,
      v: 1,
      o: "history_relink",
      p: { links: [{ from: "card_dead", c: LIVE }], at: NOW },
    };

    await expect(
      applyOp(db as unknown as IDatabaseService, "remote-dev", entry, { debug: () => {}, error: () => {} })
    ).resolves.toBeUndefined();
    expect(logsOf("card_dead")).toBe(1);
  });
});
