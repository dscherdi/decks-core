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
  DIRECTORY_TABLES_SQL,
  CURRENT_SCHEMA_VERSION,
  BACKUP_TABLES_SQL,
  buildMigrationSQL,
  reviewCardDaysSQL,
} from "./database/schemas";
export { remapCardIdsToDeckIndependent } from "./database/remapCardIds";
export * from "./database/sql-types";
export {
  aiConceptId,
  aiSessionValues,
  aiStagedCardValues,
  applyRowPatch,
} from "./database/ai-rows";
export type {
  IDatabaseService,
  ISyncLog,
  ILogger,
  IBackupService,
  QueryConfig,
  JournalStateRow,
} from "./database/DatabaseService.interface";

// Deck directory: .dpkg packages and the decks installed from them.
export * from "./services/directory";
export { sha256Hex } from "./utils/sha256";
export type { JsonValue, JsonObject } from "./utils/json";

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
export {
  formatBadgeParts,
  formatBadgeLabel,
  isPositiveFlag,
} from "./services/FilterBadgeFormatter";
export type { BadgeParts, DeckLookup } from "./services/FilterBadgeFormatter";
export { Scheduler } from "./services/Scheduler";
export type { SchedulerOptions, SchedulingPreview, SessionProgress, NewSession } from "./services/Scheduler";
export { StatisticsService } from "./services/StatisticsService";
export type {
  TimeframeStats,
  FutureDueData,
  BacklogForecastData,
} from "./services/StatisticsService";
export { CustomDeckService } from "./services/CustomDeckService";
export { TagGroupService } from "./services/TagGroupService";
export { computeCardHealth, isCardLeech, isCardDense } from "./services/CardHealth";
export type {
  CardHealthThresholds,
  CardHealth,
  ExamHealthContext,
  ExamHealthIssue,
} from "./services/CardHealth";
export { classifyExamBody } from "./services/ExamClassifier";
export type {
  ExamOption,
  ExamInvalidReason,
  ExamBodyClassification,
} from "./services/ExamClassifier";
export {
  stripInlineMarkdown,
  normalizeExamAnswer,
  isTypedAnswerCorrect,
  indexSetsEqual,
  getTypeInAnswerLine,
  checkTypeInGradability,
  extractAnswerNumbers,
  numericAnswerVerdict,
  localMeaningVerdict,
  looksLikeCodeAnswer,
  MAX_MEANING_ANSWER_LENGTH,
} from "./services/ExamGrading";
export type { TypeInGradability } from "./services/ExamGrading";
export { shuffleInPlace, sampleWithoutReplacement } from "./utils/sampling";
export {
  ExamAttempt,
  buildExamPool,
  drawExamQuestions,
  examQuestionText,
  EXAM_TARGET_BLANK,
  EXAM_INERT_BLANK,
} from "./services/ExamAttempt";
export type {
  ExamQuestion,
  ExamGivenAnswer,
  ExamQuestionOutcome,
  ExamSkipReason,
  ExamPool,
  ExamJudgeItem,
} from "./services/ExamAttempt";
export { judgePending } from "./services/ExamJudging";
export type { ExamJudge, ExamJudgeVerdict, JudgeOutcome } from "./services/ExamJudging";
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
export {
  AnkiDeckRenderer,
  readAnkiEarlierRows,
  readAnkiPins,
  DEFAULT_ANKI_CARDS_PER_FILE,
} from "./services/migration/anki/AnkiDeckRenderer";
export type {
  AnkiEarlierRow,
  AnkiRenderOptions,
  AnkiRenderedDeck,
} from "./services/migration/anki/AnkiDeckRenderer";
export { AnkiHistoryImporter } from "./services/migration/anki/AnkiHistoryImporter";
export { parseMediaManifest, isZstd } from "./services/migration/anki/AnkiMediaManifest";
export type {
  AnkiRevlogRow,
  AnkiDeckItem,
  AnkiHistoryDb,
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
  AiSessionUpsertOp,
  AiStagedCardsUpsertOp,
  AiConceptsSaveOp,
  DirectoryDeckRemoveOp,
  ClientHelloOp,
} from "./services/SyncLog.types";
export { KNOWN_OP_TYPES_V1 } from "./services/SyncLog.types";
export { applyOp } from "./services/SyncLog.handlers";
export { sessionName, sourceDisplayName } from "./services/ai/session-name";
export {
  MIN_PASSAGE_CHARS,
  MAX_PASSAGE_CHARS,
  passageFrom,
  passageSource,
} from "./services/ai/passage";
export type { PassageText } from "./services/ai/passage";

// AI refactoring
export { AiRefactoringService } from "./services/ai/AiRefactoringService";
export { createProvider } from "./services/ai/providers";
export {
  DECKS_PRO_DEFAULT_BASE_URL,
  DECKS_PRO_SITE_URL,
  PROVIDER_MODELS,
  DECKS_TIER_FAST,
  DECKS_TIER_QUALITY,
  ocrSentinelForTier,
  critiqueSentinelForTier,
  DECKS_CRITIQUE_FAST,
  DECKS_CRITIQUE_QUALITY,
  DECKS_CHAT,
  DECKS_GRADE,
  DECKS_CONCEPT_MAP,
  DECKS_OVERLAP,
  DECKS_CONCEPTS,
} from "./services/ai/models";
export type { AiModelOption } from "./services/ai/models";
// AI generation
export { AiGenerationService } from "./services/ai/AiGenerationService";
export type {
  GenerateDebugInfo,
  GenerateHandlers,
  GenerateResult,
  GenerateRoundsRequest,
  GenerateChunkedRequest,
  GenerateChunkedResult,
  SourceChunk,
} from "./services/ai/AiGenerationService";
export {
  planChunks,
  shouldChunk,
  chunkLabel,
  ESTIMATED_PAGE_CHARS,
  CHUNK_MIN_PAGES,
  CHUNK_MIN_CHARS,
  type ChunkUnit,
  type PlannedChunk,
  type ChunkPlanOptions,
} from "./services/ai/chunks";
export {
  buildGenerationMessages,
  parseGeneratedCards,
  GenerationStreamParser,
  CARD_DELIMITER,
} from "./services/ai/generation-prompt";
export type {
  GeneratedCard,
  GeneratedCardType,
  GenerateRequest,
} from "./services/ai/generation-prompt";
export {
  buildHeaderParagraphCard,
  buildHeaderParagraphContent,
  buildTableContent,
  sourcePageNote,
  withSourcePage,
  headingHashes,
} from "./services/ai/compose";
export {
  formatPageList,
  gapPages,
  heatTone,
  pageHeat,
  summarizeHeat,
} from "./services/ai/coverage";
export type {
  PageHeatCell,
  PageHeatSummary,
  PageHeatTone,
} from "./services/ai/coverage";
export { generatedCardId, heldByOtherDecks, partitionAgainstDeck } from "./services/ai/dedup";
export { lexicalCandidates, overlapTokens, overlapCardFor } from "./services/ai/overlap";
export type { OverlapCandidate, OverlapCard } from "./services/ai/overlap";
export { AiMatchService, MATCH_CHUNK_SIZE } from "./services/ai/AiMatchService";
export type { DedupResult } from "./services/ai/dedup";
export {
  DISTRACTOR_CODES,
  RUBRIC_CODES,
  isDistractorCode,
  buildCritiqueMessages,
  isRubricCode,
  parseVerdicts,
  settleVerdicts,
  isKeptOverFlag,
  serializeForCritique,
} from "./services/ai/critique-prompt";
export type {
  CardVerdict,
  CritiqueCard,
  CritiqueRequest,
  RubricCode,
  RubricVerdict,
} from "./services/ai/critique-prompt";
export { AiChatService } from "./services/ai/AiChatService";
export type { ChatResult } from "./services/ai/AiChatService";
export {
  CHAT_HISTORY_TURNS,
  buildChatMessages,
  deckForChat,
  parseChatAnswer,
  recentTurns,
} from "./services/ai/chat";
export type {
  AnswerGap,
  ChatAnswer,
  ChatRequest,
  ChatTurn,
} from "./services/ai/chat";
export { AiConceptService } from "./services/ai/AiConceptService";
export type { ConceptResult, ConceptChunkHandlers } from "./services/ai/AiConceptService";
export {
  noteUnits,
  unitSource,
  unitLabel,
  textSourceKey,
  isPdfSourceKey,
  TEXT_SOURCE_PREFIX,
  type SourceUnit,
} from "./services/ai/source-units";
export { AiCritiqueService } from "./services/ai/AiCritiqueService";
export { AiGradingService, GRADE_CHUNK_SIZE } from "./services/ai/AiGradingService";
export { parseGradeVerdicts } from "./services/ai/grading";
export type {
  CritiqueDebugInfo,
  CritiqueResult,
} from "./services/ai/AiCritiqueService";
export { INVALID_QUESTION_FIXES, fixActionFor, fixFields, fixInstructionFor, fixedCard, formatIssueSummary, isQuestionShaped, originForFix } from "./services/ai/fixes";
export {
  REPAIR_LAPSE_THRESHOLD,
  wantsRepair,
} from "./services/ai/repair";
export {
  clusterPages,
  missedPages,
  missesSectionCards,
  missesSessionPrompt,
  missesSummary,
  weakSections,
} from "./services/ai/exam-misses";
export type {
  AttemptMiss,
  WeakSection,
} from "./services/ai/exam-misses";
export {
  autoWeightByPages,
  isPlannable,
  blueprintTotal,
  clampSectionQuestions,
  mixFromPool,
  mixTotal,
  sectionHasNothingToLearn,
} from "./services/ai/exam-blueprint";
export type {
  BlueprintSection,
  QuestionMix,
} from "./services/ai/exam-blueprint";
export {
  buildConceptMessages,
  buildConceptRows,
  cardsForConcepts,
  cleanConcepts,
  conceptNeedle,
  conceptsByPage,
  conceptState,
  isCrammed,
  isFailingCard,
  CRAMMED_CODES,
  filterConceptRows,
  pageConceptTone,
  parseConcepts,
  tallyConcepts,
  unmatchedCards,
} from "./services/ai/concepts";
export type {
  ConceptCard,
  ConceptMapCard,
  ConceptCoverage,
  ConceptFilter,
  ConceptRequest,
  ConceptRow,
  ConceptState,
  ConceptTally,
  PageConceptTone,
  SourceConcept,
} from "./services/ai/concepts";
export {
  buildMcqContent,
  buildMcqMarkdown,
  checkGeneratedMcq,
} from "./services/ai/mcq";
export type { McqCheck, McqProblem, StagedMcq } from "./services/ai/mcq";
export {
  insertAfter,
  isRefinement,
  lastResultBlock,
  continuationCards,
  offersContinue,
  pruneBlocks,
  supersededIds,
  localRowId,
  nextRowCounter,
  roundsByTurn,
  roundSummary,
  threadFromTurns,
} from "./services/ai/thread";
export type { ThreadBlock, RoundSummary, SummaryRow } from "./services/ai/thread";
export {
  flagTally,
  hubTotals,
  keepRate,
  relativeAge,
} from "./services/ai/hub";
export type {
  HubTotals,
  RelativeUnit,
  SessionCounts,
} from "./services/ai/hub";
export type { CardOrigin, FixAction } from "./services/ai/fixes";
export { planAnchorLine } from "./utils/anchor-token-plan";
export type { AnchorLinePlan } from "./utils/anchor-token-plan";
export { DECKS_OVERVIEW, SPLIT_INSTRUCTION } from "./services/ai/prompts";
export {
  cardTypeFieldGuidance,
  parseProposed,
  parseSplitProposed,
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
export { HttpStatusError } from "./services/ai/HttpClient";
export { stageLabel, SILENT_THINKING_MS, type GenerationStage } from "./services/ai/stages";
export { ThinkingBuffer, THINKING_CAP } from "./services/ai/thinking";
export {
  checkCardFormat,
  repairCardFormat,
  scanMath,
  maskCode,
  isInlineMathBody,
  MATH_BLOCK_RE,
  MATH_INLINE_RE,
  type FormatIssue,
  type FormatIssueKind,
  type FormatField,
  type FormatCard,
  type MathValidator,
  type MathSpan,
} from "./services/ai/format-check";
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
  generateAnchorId,
  hash64,
} from "./utils/hash";
export {
  DK_TOKEN_REGEX,
  isAnchorCommentBody,
  stripAnchorTokens,
  extractAnchorTokens,
  extractLineAnchors,
  findAnchorSpans,
  formatAnchorToken,
  headerBindingKey,
  clozeBindingKey,
  reverseBindingKey,
  titleBindingKey,
  titleClozeBindingKey,
  tableBindingKey,
  occlusionBindingKey,
  questionBindingKey,
  edgeBindingKey,
  nodeBindingKey,
  isIdValue,
  isIdKey,
  decodeAnchorValue,
  encodeAnchorValue,
  parseBindingKey,
  cardIdForKey,
} from "./utils/anchors";
export {
  scanClozeDeletions,
  scanLineDeletions,
  hasClozeDeletion,
} from "./utils/cloze-scanner";
export type { ClozeDeletion } from "./utils/cloze-scanner";
export {
  AnchorUpgrader,
  CARD_IDENTITY_VERSION,
  dependsOnBinding,
  helloOp,
  olderDevices,
} from "./services/AnchorUpgrader";
export type { DeviceLog, UpgradeDeck } from "./services/AnchorUpgrader";
export { wantsReverseCards } from "./utils/frontmatter";
export {
  carryBodyAnchors,
  carryRowToken,
  refitPackedValue,
  tableClozeSource,
} from "./utils/anchor-carry";
export type {
  AnchorValueKind,
  AnchorRole,
  AnchorToken,
  AnchorSpan,
  LineAnchor,
} from "./utils/anchors";
export {
  addCalendarDays,
  toLocalDateString,
  toLocalDateTimeString,
  getLocalDateSQL,
  getLocalHourSQL,
  getStudyDaySQL,
  studyDayKey,
  studyDayStart,
} from "./utils/date-utils";
export {
  buildBackupFilename,
  parseBackupFilename,
  backupTimestamp,
  backupTimeOfDay,
} from "./utils/backup-names";
export type { ParsedBackupName } from "./utils/backup-names";
export {
  parseSteps,
  validateLearningSteps,
  validateRelearningSteps,
  getDefaultLearningSteps,
  getDefaultRelearningSteps,
  formatStepInterval,
} from "./utils/step-parser";
export { yieldToUI, yieldEvery, processWithYielding } from "./utils/ui";
export { shouldShowReleaseNotes } from "./utils/release-notes";
export type { ReleaseNotesOptions } from "./utils/release-notes";
export {
  getTestDeckPath,
  getTestDeckContent,
  getTemplateShowcaseFolder,
  getTemplateShowcasePath,
  getTemplateShowcaseContent,
  getExamDeckPath,
  getExamDeckTag,
  getExamDeckFrontmatterTag,
  getExamDeckContent,
} from "./utils/test-deck";
export {
  hashPdf,
  hashImage,
  extractOutline,
  extractPageText,
  buildSectionContent,
  buildSectionPages,
  pageTextUsable,
  pageMarker,
  pageFromLabel,
  pagesForSelection,
  sectionsForSelection,
  chapterIdsForPages,
  type SelectedSection,
} from "./services/pdf/pdf";
export type {
  ChapterNode,
  PageText,
  PdfDoc,
  PdfPage,
  PdfParseMode,
  OcrRunner,
} from "./services/pdf/pdf";
export { PdfOcrCache } from "./services/pdf/PdfOcrCache";
export type {
  FileStore,
  PageRenderer,
  OcrProgress,
  OcrDebugEntry,
} from "./services/pdf/PdfOcrCache";
export { mapWithConcurrency } from "./utils/concurrency";
export {
  levenshteinSimilarity,
  levenshteinSimilarityAbove,
  levenshteinDistance,
  naturalCompare,
} from "./utils/string";
export { sortDeckList, filterByMinCount } from "./utils/deck-sort";
export {
  normalizeTag,
  ancestorTags,
  isUnderTag,
  matchesIgnore,
  pickDeckTag,
  flatTagsFor,
  studyTagsFor,
  pickProfileMapping,
  parseIgnoredTags,
  tagScopeFromSettings,
} from "./utils/deck-tags";
export type { TagScopeOptions } from "./utils/deck-tags";
export {
  buildDeckTree,
  filterDeckTree,
  sortDeckTree,
  flattenDeckTree,
  allBranchIds,
} from "./utils/deck-tree";
export type {
  TreeKind,
  TreeSection,
  TreeNode,
  DeckTree,
  FlatRow,
  BuildDeckTreeInput,
} from "./utils/deck-tree";
export { MinHeap } from "./utils/min-heap";
export { formatTime, formatPace, formatByteSize } from "./utils/formatting";
export {
  splitTableLine,
  escapeTableCell,
  unescapeTableCell,
} from "./utils/markdown-table";
export { cardFieldDefs, fieldSetValue } from "./utils/card-fields";
export type { NoteAccess } from "./services/NoteAccess";
export { AnchorStamper } from "./services/AnchorStamper";
export {
  isReverseCardId,
  noteCardGroups,
  noteCardOf,
  type NoteCardGroup,
} from "./services/ReverseCards";
export type { StampOutcome } from "./services/AnchorStamper";
export {
  findBreadcrumbSection,
  findFlashcardLineInRange,
  findFlashcardLine,
  findFlashcardSegment,
} from "./utils/source-navigator";
export type { CardFieldDef } from "./utils/card-fields";
export { prepareClozeMath } from "./utils/clozeMath";
export type { PreparedClozeMath } from "./utils/clozeMath";
export { toSpeechText } from "./utils/toSpeechText";
export type { ToSpeechOptions } from "./utils/toSpeechText";
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
export { formatMessage, formatSegments } from "./i18n/message";
export type { MessageParams, MessageSegment } from "./i18n/message";
export { SUPPORTED_LANGUAGES } from "./i18n/locales";
export type { LanguageCode, LanguagePreference, Translations } from "./i18n/locales";
