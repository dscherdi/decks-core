// Algorithm — single source of truth (the plugin re-exports these).
export * from "./algorithm/fsrs";
export * from "./algorithm/fsrs-weights";
export * from "./algorithm/fsrs-bounds";
export * from "./algorithm/fsrs-optimizer";

// Database types & SQL — single source of truth (the plugin re-exports these).
export * from "./database/types";
export {
  SQL_QUERIES,
  CREATE_TABLES_SQL,
  CURRENT_SCHEMA_VERSION,
  BACKUP_TABLES_SQL,
  buildMigrationSQL,
} from "./database/schemas";
export * from "./database/sql-types";
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
export * from "./services/HLC";
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
export { PROVIDER_MODELS } from "./services/ai/models";
export type { AiModelOption } from "./services/ai/models";
// AI generation
export { AiGenerationService } from "./services/ai/AiGenerationService";
export type {
  GenerateHandlers,
  GenerateResult,
} from "./services/ai/AiGenerationService";
export {
  buildGenerationMessages,
  parseGeneratedCards,
  GenerationStreamParser,
  CARD_DELIMITER,
} from "./services/ai/generation-prompt";
export type {
  GeneratedCard,
  GenerateRequest,
} from "./services/ai/generation-prompt";
export {
  FLASHCARD_DESIGN_GUIDANCE,
  SPLIT_INSTRUCTION,
  cardTypeFieldGuidance,
} from "./services/ai/refactor-prompt";
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
  RefactorDebugInfo,
  RefactorImage,
} from "./services/ai/types";
export type { HttpClient, HttpRequest, HttpResponse } from "./services/ai/HttpClient";
export type {
  AiProvider,
  ProviderCompleteRequest,
} from "./services/ai/providers/AiProvider";

// Utils
export {
  generateFlashcardId,
  generateOldFlashcardId,
  generateDeckId,
  generateContentHash,
  generateDeckGroupId,
  generateClozeFlashcardId,
  generateReverseFlashcardId,
  generateCustomDeckId,
  generateCustomDeckCardId,
  generateSpatialFlashcardId,
  generateSpatialClozeFlashcardId,
} from "./utils/hash";
export {
  toLocalDateString,
  toLocalDateTimeString,
  getLocalDateSQL,
  getLocalHourSQL,
} from "./utils/date-utils";
export {
  parseSteps,
  validateLearningSteps,
  validateRelearningSteps,
  getDefaultLearningSteps,
  getDefaultRelearningSteps,
  formatStepInterval,
} from "./utils/step-parser";
export { yieldToUI, yieldEvery, processWithYielding } from "./utils/ui";
export { levenshteinSimilarity } from "./utils/string";
export { sortDeckList, filterByMinCount } from "./utils/deck-sort";
export { MinHeap } from "./utils/min-heap";
export { formatTime, formatPace } from "./utils/formatting";
export {
  splitTableLine,
  escapeTableCell,
  unescapeTableCell,
} from "./utils/markdown-table";
export { cardFieldDefs, fieldSetValue } from "./utils/card-fields";
export type { CardFieldDef } from "./utils/card-fields";
export {
  SPLITTABLE,
  isSplittable,
  effectiveSplit,
  cardResultPatch,
  acceptAllStates,
  discardAllStates,
  setCardStatus,
  applyBatch,
} from "./utils/batch-refactor";
export type {
  BatchStatus,
  BatchCardState,
  ApplyCallbacks,
  ApplyResult,
} from "./utils/batch-refactor";

// Settings & i18n
export type { DecksSettings } from "./settings";
export { I18n } from "./i18n/I18n";
export { SUPPORTED_LANGUAGES } from "./i18n/locales";
export type { LanguageCode, LanguagePreference, Translations } from "./i18n/locales";
