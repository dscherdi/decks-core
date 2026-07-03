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
export { remapCardIdsToDeckIndependent } from "./database/remapCardIds";
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
export {
  isOcclusionV2,
  serializeOcclusionBack,
  parseOcclusionBack,
  occlusionV2HashInput,
  activeMaskIdForCard,
  occlusionImageLinkpath,
} from "./services/occlusion/OcclusionV2";
export { OcclusionV2Parser } from "./services/occlusion/OcclusionV2Parser";
export {
  OCCLUSION_V2_VERSION,
  type OcclusionMask,
  type OcclusionDoc,
  type OcclusionParseResult,
} from "./services/occlusion/OcclusionV2.types";
export { CanvasParser } from "./services/CanvasParser";
export type { CanvasContent, CanvasTextNode } from "./services/CanvasParser";
export { CanvasFlashcardExtractor } from "./services/CanvasFlashcardExtractor";
export { compileFilter } from "./services/FilterEngine";
export type { FilterCompileOptions, CompiledFilter } from "./services/FilterEngine";
export { evaluateFilter } from "./services/FilterEvaluator";
export { Scheduler } from "./services/Scheduler";
export type { SchedulerOptions, SchedulingPreview, SessionProgress, NewSession } from "./services/Scheduler";
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

// Table template engine
export {
  extractTemplateBlocks,
  stripTemplateBlocks,
  mergeTemplate,
  referencedVariables,
  templateIsSatisfied,
  parseTemplateFile,
  resolveCardTemplate,
} from "./services/templates";
export type {
  TemplateEngine,
  TemplateSide,
  TemplateField,
  ResolvedTemplateSet,
  ResolvedRender,
} from "./services/templates";
export { LegacySrMigrator } from "./services/migration/LegacySrMigrator";
export type {
  FsrsState,
  ClozeEntry,
  MigratedCard,
  MigrationFormat,
  ProcessOptions,
  ProcessResult,
  RenderOptions,
  RenderedFile,
  WholeNoteOptions,
} from "./services/migration/LegacySrMigrator";
export { SrHistoryImporter } from "./services/migration/SrHistoryImporter";
export type {
  MigrationProfileFsrs,
  MigrationDeckItem,
  HistoryDb,
} from "./services/migration/SrHistoryImporter";
export { AnkiCollectionParser } from "./services/migration/anki/AnkiCollectionParser";
export type { AnkiParseOptions } from "./services/migration/anki/AnkiCollectionParser";
export { AnkiSanitizer } from "./services/migration/anki/AnkiSanitizer";
export type {
  SanitizeResult,
  SanitizeOptions,
  HtmlToMarkdown,
} from "./services/migration/anki/AnkiSanitizer";
export { AnkiTemplateEngine } from "./services/migration/anki/AnkiTemplateEngine";
export type {
  AnkiTemplateData,
  AnkiTemplateResult,
  AnkiExtraField,
} from "./services/migration/anki/AnkiTemplateEngine";
export { AnkiTemplateExporter } from "./services/migration/anki/AnkiTemplateExporter";
export type { AnkiTemplateFile } from "./services/migration/anki/AnkiTemplateExporter";
export { AnkiOcclusionExtractor } from "./services/migration/anki/AnkiOcclusionExtractor";
export type { AnkiOcclusionResult } from "./services/migration/anki/AnkiOcclusionExtractor";
export { AnkiDeckRenderer } from "./services/migration/anki/AnkiDeckRenderer";
export type { AnkiRenderedDeck } from "./services/migration/anki/AnkiDeckRenderer";
export { AnkiHistoryImporter } from "./services/migration/anki/AnkiHistoryImporter";
export { parseMediaManifest, isZstd } from "./services/migration/anki/AnkiMediaManifest";
export type {
  AnkiRevlogRow,
  AnkiDeckItem,
  AnkiImportHistoryOptions,
} from "./services/migration/anki/AnkiHistoryImporter";
export type {
  AnkiModel,
  AnkiModelField,
  AnkiTemplate,
  AnkiDeckMeta,
  AnkiScheduling,
  AnkiParsedCard,
  AnkiParseResult,
  AnkiCardKind,
  AnkiTemplateRow,
} from "./services/migration/anki/AnkiTypes";
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
  generateLegacyDeckScopedFlashcardId,
  generateDeckId,
  generateContentHash,
  generateDeckGroupId,
  generateClozeFlashcardId,
  generateReverseFlashcardId,
  generateCustomDeckId,
  generateCustomDeckCardId,
  generateSpatialFlashcardId,
  generateSpatialClozeFlashcardId,
  generateOcclusionV2FlashcardId,
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
export { levenshteinSimilarity, naturalCompare } from "./utils/string";
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
export { prepareClozeMath } from "./utils/clozeMath";
export type { PreparedClozeMath } from "./utils/clozeMath";
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
