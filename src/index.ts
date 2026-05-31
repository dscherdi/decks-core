// Algorithm
export { FSRS } from "./algorithm/fsrs";
export type { FSRSParameters, SchedulingInfo, RatingLabel } from "./algorithm/fsrs";
export {
  FSRS_WEIGHTS_STANDARD,
  DEFAULT_FSRS_PARAMETERS,
  getWeightsForProfile,
  getMinMinutesForProfile,
  getMaxIntervalDaysForProfile,
  validateFSRSWeights,
} from "./algorithm/fsrs-weights";
export type { FSRSProfile } from "./algorithm/fsrs-weights";
export { optimizeWeights } from "./algorithm/fsrs-optimizer";
export type { OptimizerReviewInput, TrainingResult } from "./algorithm/fsrs-optimizer";

// Database types & SQL
export type {
  Flashcard,
  FlashcardType,
  FlashcardState,
  Deck,
  DeckWithProfile,
  DeckProfile,
  DeckGroup,
  ProfileTagMapping,
  ReviewLog,
  ReviewSession,
  CustomDeck,
  CustomDeckType,
  FsrsWeightSet,
} from "./database/types";
export {
  DEFAULT_DECK_PROFILE,
  DEFAULT_PROFILE_ID,
} from "./database/types";
export {
  SQL_QUERIES,
  CREATE_TABLES_SQL,
  CURRENT_SCHEMA_VERSION,
  BACKUP_TABLES_SQL,
  buildMigrationSQL,
} from "./database/schemas";
export type { SqlJsValue, SqlRecord, SqlRow } from "./database/sql-types";
export type {
  IDatabaseService,
  ISyncLog,
  ILogger,
  IBackupService,
  QueryConfig,
  JournalStateRow,
} from "./database/DatabaseService.interface";

// Services
export { FlashcardParser } from "./services/FlashcardParser";
export type { ParsedFlashcard } from "./services/FlashcardParser";
export { CanvasParser } from "./services/CanvasParser";
export type { CanvasContent, CanvasTextNode } from "./services/CanvasParser";
export { CanvasFlashcardExtractor } from "./services/CanvasFlashcardExtractor";
export { compileFilter } from "./services/FilterEngine";
export type { FilterCompileOptions, CompiledFilter } from "./services/FilterEngine";
export { evaluateFilter } from "./services/FilterEvaluator";
export { Scheduler } from "./services/Scheduler";
export type { SchedulerOptions, SessionProgress, NewSession } from "./services/Scheduler";
export { StatisticsService } from "./services/StatisticsService";
export { CustomDeckService } from "./services/CustomDeckService";
export { TagGroupService } from "./services/TagGroupService";
export { computeCardHealth, isCardLeech, isCardDense } from "./services/CardHealth";
export type { CardHealthThresholds, CardHealth } from "./services/CardHealth";
export { FsrsOptimizationService } from "./services/FsrsOptimizationService";
export { FlashcardSynchronizer } from "./services/FlashcardSynchronizer";
export type {
  SyncData,
  SyncResult,
  RawDatabase,
  RawStatement,
} from "./services/FlashcardSynchronizer";
export { hlcSend, hlcReceive, hlcParse } from "./services/HLC";
export type { HLCValue, HLCState } from "./services/HLC";
export type {
  SyncOpV1,
  SyncLogEntry,
  RateOp,
  DeckResetOp,
  CustomDeckResetOp,
  ProfileUpsertOp,
  ProfileDeleteOp,
  TagMappingUpsertOp,
  TagMappingDeleteOp,
  CustomDeckUpsertOp,
  CustomDeckDeleteOp,
  CustomDeckCardAddOp,
  CustomDeckCardRemoveOp,
  SessionStartOp,
  SessionProgressOp,
  SessionEndOp,
} from "./services/SyncLog.types";
export { KNOWN_OP_TYPES_V1 } from "./services/SyncLog.types";
export { applyOp } from "./services/SyncLog.handlers";

// AI refactoring
export { AiRefactoringService } from "./services/ai/AiRefactoringService";
export { createProvider } from "./services/ai/providers";
export { AiError, REFACTOR_FIELD_KEYS } from "./services/ai/types";
export type {
  AiProviderId,
  AiProviderConfig,
  AiErrorCode,
  RefactorFieldSet,
  RefactorCardType,
  RefactorRequest,
  RefactorResult,
  RefactorProposal,
} from "./services/ai/types";
export type { HttpClient, HttpRequest, HttpResponse } from "./services/ai/HttpClient";
export type { AiProvider } from "./services/ai/providers/AiProvider";

// Utils
export {
  generateFlashcardId,
  generateDeckId,
  generateContentHash,
  generateClozeFlashcardId,
  generateReverseFlashcardId,
} from "./utils/hash";
export { toLocalDateString, toLocalDateTimeString } from "./utils/date-utils";
export { parseSteps } from "./utils/step-parser";
export { yieldToUI, yieldEvery } from "./utils/ui";
export { levenshteinSimilarity } from "./utils/string";
export { sortDeckList } from "./utils/deck-sort";
export { MinHeap } from "./utils/min-heap";

// Settings & i18n
export type { DecksSettings } from "./settings";
export { I18n } from "./i18n/I18n";
export { SUPPORTED_LANGUAGES } from "./i18n/locales";
export type { LanguageCode, LanguagePreference, Translations } from "./i18n/locales";
