import type {
  Deck,
  DeckProfile,
  DeckWithProfile,
  ProfileTagMapping,
  Flashcard,
  ReviewLog,
  ReviewSession,
  CustomDeck,
  CustomDeckType,
  FsrsWeightSet,
  DeckTemplate,
} from "./types";
import type { SqlJsValue, SqlRecord, SqlRow } from "./sql-types";
import type { SyncData, SyncResult } from "../services/FlashcardSynchronizer";
import type { FilterCompileOptions } from "../services/FilterEngine";
import type { SyncOpV1 } from "../services/SyncLog.types";

export interface QueryConfig {
  asObject?: boolean;
}

/** Minimal sync log interface — satisfied by the full SyncLog class. */
export interface ISyncLog {
  append<T extends SyncOpV1>(op: T): number;
  cancelBufferedRate?: (logId: string) => boolean;
}

/** Minimal logger interface — satisfied by the plugin's Logger class and console. */
export interface ILogger {
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  performance?(label: string, ...args: unknown[]): void;
}

/** Minimal backup service interface — satisfied by the plugin's BackupService class. */
export interface IBackupService {
  // Return value is ignored by the scheduler; widened so concrete services
  // that return a backup path (Promise<string>) satisfy the interface.
  createBackup(db: IDatabaseService): Promise<unknown>;
}

export interface IDatabaseService {
  migrationNotice: string | null;

  initialize(): Promise<void>;
  close(): Promise<void>;
  save(): Promise<void>;

  setFilterCompileOptions(options: FilterCompileOptions): void;
  setSyncLog(syncLog: ISyncLog): void;
  isDirty(): boolean;

  getDeckLastSyncedMtime(deckId: string): Promise<number>;
  setDeckLastSyncedMtime(deckId: string, mtime: number): Promise<void>;
  clearLastSyncedMtimeForProfile(profileId: string): Promise<void>;
  getAllDeckSyncMeta(): Promise<
    { id: string; filepath: string; lastSyncedMtime: number }[]
  >;

  createDeck(
    deck: Omit<Deck, "created" | "modified" | "profileId"> & { id?: string; profileId?: string }
  ): Promise<string>;
  getDeckById(id: string): Promise<Deck | null>;
  getDeckByFilepath(filepath: string): Promise<Deck | null>;
  getDeckByTag(tag: string): Promise<Deck | null>;
  getAllDecks(): Promise<Deck[]>;
  updateDeck(id: string, updates: Partial<Deck>): Promise<void>;
  updateDeckTimestamp(deckId: string): Promise<void>;
  updateDeckLastReviewed(deckId: string, timestamp: string): Promise<void>;
  setDeckFileTags(deckId: string, fileTags: string[]): Promise<void>;
  // Deck template cache (synced from the template folder).
  getAllDeckTemplates(): Promise<DeckTemplate[]>;
  upsertDeckTemplate(
    template: Omit<DeckTemplate, "created" | "modified">
  ): Promise<void>;
  deleteDeckTemplateByFile(sourceFile: string): Promise<void>;
  renameDeckTemplate(
    oldSourceFile: string,
    newSourceFile: string,
    newId: string
  ): Promise<void>;
  renameDeck(
    oldDeckId: string,
    newDeckId: string,
    newName: string,
    newFilepath: string
  ): Promise<void>;
  deleteDeck(id: string): Promise<void>;
  deleteDeckByFilepath(filepath: string): Promise<void>;
  getDecksByTag(tag: string): Promise<Deck[]>;

  createProfile(profile: Omit<DeckProfile, "created" | "modified">): Promise<string>;
  getProfileById(id: string): Promise<DeckProfile | null>;
  getProfileByName(name: string): Promise<DeckProfile | null>;
  getAllProfiles(): Promise<DeckProfile[]>;
  getDefaultProfile(): Promise<DeckProfile>;
  updateProfile(
    id: string,
    updates: Partial<Omit<DeckProfile, "id" | "created" | "modified" | "isDefault">>
  ): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  getDeckCountForProfile(profileId: string): Promise<number>;
  getDecksByProfile(profileId: string): Promise<Deck[]>;

  createTagMapping(profileId: string, tag: string): Promise<string>;
  getTagMappingsForProfile(profileId: string): Promise<ProfileTagMapping[]>;
  getAllTagMappings(): Promise<ProfileTagMapping[]>;
  getProfileIdForTag(tag: string): Promise<string | null>;
  deleteTagMapping(id: string): Promise<void>;
  applyProfileToTag(profileId: string, tag: string): Promise<number>;

  getDeckWithProfile(deckId: string): Promise<DeckWithProfile | null>;
  getAllDecksWithProfiles(): Promise<DeckWithProfile[]>;

  createFlashcard(flashcard: Omit<Flashcard, "id" | "created" | "modified">): Promise<void>;
  getFlashcardById(flashcardId: string): Promise<Flashcard | null>;
  getFlashcardsByDeck(deckId: string): Promise<Flashcard[]>;
  getAllFlashcards(): Promise<Flashcard[]>;
  getAllFlashcardTags(): Promise<string[]>;
  getDueFlashcards(deckId: string): Promise<Flashcard[]>;
  getReviewableFlashcards(deckId: string): Promise<Flashcard[]>;
  getNewCardsForReview(deckId: string): Promise<Flashcard[]>;
  getReviewCardsForReview(deckId: string): Promise<Flashcard[]>;
  updateFlashcard(flashcardId: string, updates: Partial<Flashcard>): Promise<void>;
  updateFlashcardDeckIds(oldDeckId: string, newDeckId: string): Promise<void>;
  migrateFlashcardIdentity(
    oldId: string,
    newCard: Omit<Flashcard, "created" | "modified">
  ): Promise<void>;
  deleteFlashcard(id: string): Promise<void>;
  deleteFlashcardsByFile(sourceFile: string): Promise<void>;

  syncFlashcardsForDeck(
    data: SyncData,
    progressCallback?: (progress: number, message?: string) => void
  ): Promise<SyncResult>;
  syncFlashcardsForDeckWorker?(
    data: SyncData,
    progressTracker?: unknown
  ): Promise<SyncResult>;

  batchCreateFlashcards(
    flashcards: Array<Omit<Flashcard, "created" | "modified">>
  ): Promise<void>;
  batchUpdateFlashcards(
    updates: Array<{ id: string; updates: Partial<Flashcard> }>
  ): Promise<void>;
  batchDeleteFlashcards(flashcardIds: string[]): Promise<void>;

  createReviewLog(log: Omit<ReviewLog, "id">): Promise<void>;
  insertReviewLog(reviewLog: ReviewLog): Promise<void>;
  getLatestReviewLogForFlashcard(flashcardId: string): Promise<ReviewLog | null>;
  getReviewLogById(reviewLogId: string): Promise<ReviewLog | null>;
  getLatestReviewLogForSession(sessionId: string): Promise<ReviewLog | null>;
  deleteReviewLogById(reviewLogId: string): Promise<void>;
  getAllReviewLogs(): Promise<ReviewLog[]>;
  reviewLogExists(reviewLogId: string): Promise<boolean>;
  getReviewLogsByDeck(deckId: string): Promise<ReviewLog[]>;
  getReviewLogsByDecks(deckIds: string[]): Promise<ReviewLog[]>;
  getReviewLogsForTraining(): Promise<ReviewLog[]>;

  saveTrainedWeightSet(
    input: Omit<FsrsWeightSet, "id" | "created" | "modified" | "deletedAt">
  ): Promise<string>;
  getActiveTrainedWeightSet(): Promise<FsrsWeightSet | null>;
  getAllTrainedWeightSets(): Promise<FsrsWeightSet[]>;
  clearTrainedWeights(): Promise<void>;

  createReviewSession(session: Omit<ReviewSession, "id">): Promise<string>;
  getReviewSessionById(sessionId: string): Promise<ReviewSession | null>;
  getActiveReviewSession(deckId: string): Promise<ReviewSession | null>;
  getAllReviewSessions(): Promise<ReviewSession[]>;
  updateReviewSessionDoneUnique(sessionId: string, doneUnique: number): Promise<void>;
  endReviewSession(sessionId: string): Promise<void>;
  insertReviewSession(session: ReviewSession): Promise<void>;
  reviewSessionExists(sessionId: string): Promise<boolean>;
  isCardReviewedInSession(sessionId: string, flashcardId: string): Promise<boolean>;
  countCardReviewsInSession(sessionId: string, flashcardId: string): Promise<number>;

  createCustomDeck(
    name: string,
    deckType?: CustomDeckType,
    filterDefinition?: string | null
  ): Promise<string>;
  getCustomDeckById(id: string): Promise<CustomDeck | null>;
  getCustomDeckByName(name: string): Promise<CustomDeck | null>;
  getAllCustomDecks(): Promise<CustomDeck[]>;
  updateCustomDeck(
    id: string,
    updates: { name?: string; filterDefinition?: string | null }
  ): Promise<void>;
  updateCustomDeckLastReviewed(id: string, timestamp: string): Promise<void>;
  deleteCustomDeck(id: string): Promise<void>;

  addCardsToCustomDeck(customDeckId: string, flashcardIds: string[]): Promise<void>;
  removeCardsFromCustomDeck(customDeckId: string, flashcardIds: string[]): Promise<void>;
  removeAllCardsFromCustomDeck(customDeckId: string): Promise<void>;
  getFlashcardsForCustomDeck(customDeckId: string): Promise<Flashcard[]>;
  getCustomDecksForFlashcard(flashcardId: string): Promise<CustomDeck[]>;
  getFlashcardIdsForCustomDeck(customDeckId: string): Promise<string[]>;

  countNewCardsCustomDeck(customDeckId: string): Promise<number>;
  countDueCardsCustomDeck(customDeckId: string): Promise<number>;
  countTotalCardsCustomDeck(customDeckId: string): Promise<number>;

  getDueCardsForCustomDeck(customDeckId: string): Promise<Flashcard[]>;
  getNewCardsForCustomDeck(customDeckId: string): Promise<Flashcard[]>;

  getDailyReviewCounts(
    deckId: string,
    nextDayStartsAt?: number
  ): Promise<{ newCount: number; reviewCount: number }>;

  countNewCards(deckId: string): Promise<number>;
  countDueCards(deckId: string): Promise<number>;
  countTotalCards(deckId: string): Promise<number>;
  countAllCards(): Promise<number>;
  countMatureCards(deckId: string): Promise<number>;
  // Batched per-deck stats for ALL decks in one grouped query each (fast deck-list refresh).
  getDeckCardStatsBatch(): Promise<
    { deckId: string; total: number; newCount: number; dueCount: number; matureCount: number }[]
  >;
  getDailyReviewCountsBatch(
    nextDayStartsAt?: number
  ): Promise<{ deckId: string; newCount: number; reviewCount: number }[]>;

  getScheduledDueByDay(
    deckId: string,
    startDate: string,
    endDate: string
  ): Promise<{ day: string; count: number }[]>;
  getScheduledDueByDayMulti(
    deckIds: string[],
    startDate: string,
    endDate: string
  ): Promise<{ day: string; count: number }[]>;
  getCurrentBacklog(deckId: string, currentDate: string): Promise<number>;
  getCurrentBacklogMulti(deckIds: string[], currentDate: string): Promise<number>;
  getDeckReviewCountRange(deckId: string, startDate: string, endDate: string): Promise<number>;
  countNewCardsToday(deckId: string, nextDayStartsAt?: number): Promise<number>;
  countReviewCardsToday(deckId: string, nextDayStartsAt?: number): Promise<number>;
  // Distinct cards (new + review) studied today across ALL decks (global daily cap).
  countCardsStudiedTodayAllDecks(nextDayStartsAt?: number): Promise<number>;

  purgeDatabase(): Promise<void>;
  resetDeckProgress(deckId: string): Promise<void>;
  resetCustomDeckProgress(customDeckId: string): Promise<void>;
  rebuildCardStateFromReviewLogs(): Promise<number>;

  suspendCard(cardId: string): Promise<void>;
  unsuspendCard(cardId: string): Promise<void>;
  batchSuspendCards(cardIds: string[]): Promise<void>;
  batchUnsuspendCards(cardIds: string[]): Promise<void>;
  buryCard(cardId: string, untilIso: string): Promise<void>;
  unburyCard(cardId: string): Promise<void>;
  batchBuryCards(cardIds: string[], untilIso: string): Promise<void>;
  batchUnburyCards(cardIds: string[]): Promise<void>;
  resetCard(cardId: string): Promise<void>;
  batchResetCards(cardIds: string[]): Promise<void>;

  querySql<T>(sql: string, params: SqlJsValue[], config: { asObject: true }): Promise<T[]>;
  querySql(sql: string, params?: SqlJsValue[], config?: { asObject?: false }): Promise<SqlRow[]>;
  querySql<T = SqlRecord>(
    sql: string,
    params?: SqlJsValue[],
    config?: QueryConfig
  ): Promise<T[] | SqlJsValue[][]>;

  executeSql(sql: string, params?: SqlJsValue[]): Promise<void>;

  createBackupDatabase(backupPath: string): Promise<void>;
  restoreFromBackupDatabase(backupPath: string): Promise<void>;
  /** Restore directly from raw SQLite bytes (e.g. a user-supplied backup file). */
  restoreFromBackupData(backupData: Uint8Array): Promise<void>;
  exportDatabaseToBuffer(): Promise<Uint8Array>;
  createBackupDatabaseInstance(backupData: Uint8Array): Promise<string | object>;
  queryBackupDatabase(backupDb: string | object, sql: string): Promise<SqlJsValue[][]>;
  closeBackupDatabaseInstance(backupDb: string | object): Promise<void>;

  syncWithDisk(): Promise<void>;

  getJournalState(): Promise<JournalStateRow[]>;
  upsertJournalState(row: JournalStateRow): Promise<void>;
}

export interface JournalStateRow {
  sourceDeviceId: string;
  lastAppliedSeq: number;
  lastAppliedHlc: string;
  lastAppliedAt: string;
}
