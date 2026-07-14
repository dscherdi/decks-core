import { DEFAULT_FSRS_PARAMETERS } from "../algorithm/fsrs-weights";
import type { FSRSProfile } from "../algorithm/fsrs-weights";
export type { FSRSProfile };

export type ReviewOrder = "due-date" | "random";
export type ClozeShowContext = "open" | "hidden";

export interface DeckProfile {
  id: string;
  name: string;

  hasNewCardsLimitEnabled: boolean;
  newCardsPerDay: number;
  hasReviewCardsLimitEnabled: boolean;
  reviewCardsPerDay: number;

  headerLevel: number;
  // Additional header levels (1-6) parsed as card fronts alongside the primary
  // headerLevel. Empty by default; ignored in title mode (headerLevel === 0).
  // Optional so existing profile literals/fixtures don't need updating — the DB
  // layer always populates it (defaulting to []).
  extraHeaderLevels?: number[];

  reviewOrder: ReviewOrder;

  learningSteps: string;
  relearningSteps: string;

  fsrs: {
    requestRetention: number;
    profile: FSRSProfile;
  };

  clozeEnabled: boolean;
  clozeShowContext: ClozeShowContext;

  isDefault: boolean;
  created: string;
  modified: string;
}

export const DEFAULT_PROFILE_ID = 'profile_default';
export const HEADER_LEVEL_TITLE = 0;

// Preinstalled profiles shipped with the database (seeded in schemas.ts):
// one per header level plus a title-mode profile for whole-note reviews.
export const REVIEW_PROFILE_ID = 'profile_sr_review';
export const REVIEW_PROFILE_NAME = 'Review notes';
export const PRESET_HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export function headingProfileId(level: number): string {
  return `profile_heading_${level}`;
}
export function headingProfileName(level: number): string {
  return `Heading ${level}`;
}

/**
 * Resolve the set of header levels parsed as card fronts for a profile/config.
 * Title mode (primary level 0) parses the whole note and ignores extras.
 * Otherwise the primary level plus any valid (1-6) extras, deduped.
 */
export function parseHeaderLevels(
  cfg: { headerLevel: number; extraHeaderLevels?: number[] }
): number[] {
  if (cfg.headerLevel === 0) return [0];
  const extras = (cfg.extraHeaderLevels ?? []).filter((l) => l >= 1 && l <= 6);
  return Array.from(new Set([cfg.headerLevel, ...extras]));
}

export const DEFAULT_DECK_PROFILE: Omit<DeckProfile, 'id' | 'created' | 'modified'> = {
  name: 'DEFAULT',
  hasNewCardsLimitEnabled: false,
  newCardsPerDay: 20,
  hasReviewCardsLimitEnabled: false,
  reviewCardsPerDay: 100,
  headerLevel: 2,
  extraHeaderLevels: [],
  reviewOrder: "due-date",
  learningSteps: "1m",
  relearningSteps: "10m",
  fsrs: {
    requestRetention: DEFAULT_FSRS_PARAMETERS.requestRetention,
    profile: "STANDARD",
  },
  clozeEnabled: true,
  clozeShowContext: "hidden",
  isDefault: true,
};

export interface ProfileTagMapping {
  id: string;
  profileId: string;
  tag: string;
  created: string;
}

export interface Deck {
  id: string;
  name: string;
  filepath: string;
  tag: string;
  lastReviewed: string | null;
  profileId: string;
  created: string;
  modified: string;
  // Frontmatter tags of the deck file, used for file-level (Tier 2) template
  // binding. Undefined for decks synced before this column existed.
  fileTags?: string[];
}

/** Render engine for one template face. */
export type TemplateFaceType = "md" | "html";

/**
 * A cached card template, synced from a markdown file in the template folder.
 * Bound to flashcards by tag at render time (deck_templates table).
 */
export interface DeckTemplate {
  id: string;
  sourceFile: string;
  tags: string[];
  frontTemplate: string;
  frontType: TemplateFaceType;
  backTemplate: string;
  backType: TemplateFaceType;
  notesTemplate: string | null;
  notesType: TemplateFaceType | null;
  created: string;
  modified: string;
}

/**
 * Raw table-row data captured for a flashcard so its bound template can be
 * merged at render time. Tags used for binding come from the header(s)
 * containing the table (the card's `tags`), not from the row itself.
 */
export interface TemplateRow {
  headers: string[];
  cells: string[];
}

export interface DeckWithProfile extends Deck {
  profile: DeckProfile;
}

export function deckWithProfile(deck: Deck, profile: DeckProfile): DeckWithProfile {
  return {
    ...deck,
    profile,
  };
}

export interface DeckGroup {
  type: 'group';
  tag: string;
  name: string;
  deckIds: string[];
  profile: DeckProfile;
  lastReviewed: string | null;
  created: string;
  modified: string;
}

export interface FileDeck extends DeckWithProfile {
  type: 'file';
}

export type CustomDeckType = 'manual' | 'filter';

export type FilterOperator =
  | "equals" | "not_equals"
  | "contains" | "not_contains"
  | "greater_than" | "less_than"
  | "before" | "after"
  | "is_due" | "is_new"
  | "in";

export type FilterField =
  | "deckId" | "deckTag" | "type" | "sourceFile" | "breadcrumb" | "tags"
  | "state" | "dueDate" | "difficulty" | "stability"
  | "interval" | "repetitions" | "lapses"
  | "lastReviewed" | "created"
  | "isLeech" | "isDense"
  | "isSuspended" | "isBuried";

export interface FilterRule {
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export type FilterLogic = "AND" | "OR";

export interface FilterDefinition {
  version: 1;
  logic: FilterLogic;
  rules: FilterRule[];
}

export interface CustomDeck {
  id: string;
  name: string;
  deckType: CustomDeckType;
  filterDefinition: string | null;
  lastReviewed: string | null;
  created: string;
  modified: string;
}

export interface CustomDeckCard {
  id: string;
  customDeckId: string;
  flashcardId: string;
  created: string;
}

export interface CustomDeckGroup {
  type: 'custom';
  id: string;
  name: string;
  deckType: CustomDeckType;
  filterDefinition: string | null;
  flashcardIds: string[];
  lastReviewed: string | null;
  created: string;
  modified: string;
}

export type DeckOrGroup = FileDeck | DeckGroup | CustomDeckGroup;

export function isDeckGroup(item: DeckOrGroup): item is DeckGroup {
  return item.type === 'group';
}

export function isFileDeck(item: DeckOrGroup): item is FileDeck {
  return item.type === 'file';
}

export function isCustomDeck(item: DeckOrGroup): item is CustomDeckGroup {
  return item.type === 'custom';
}

export type FlashcardState = "new" | "review";

export type FlashcardType =
  | "header-paragraph"
  | "table"
  | "cloze"
  | "image-occlusion"
  | "image-occlusion-v2"
  | "spatial";

export interface Flashcard {
  id: string;
  deckId: string;
  front: string;
  back: string;
  type: FlashcardType;
  sourceFile: string;
  contentHash: string; // Hash of back content only (front is used for ID)
  breadcrumb: string; // Header hierarchy context (e.g., "Chapter 1 > Section 2")
  notes: string; // Optional notes from third table column
  tags: string[]; // Tags inherited from header (e.g. "## Heading #math #science")
  hint: string; // Optional hint shown on the front (canvas spatial cards use edge label)
  clozeText: string | null; // The specific cloze text for this card (without == delimiters)
  clozeOrder: number | null; // Ordinal position of this cloze within the back content
  // Canvas-only: id of the source canvas text node. NULL/undefined for markdown cards.
  // Optional so existing test fixtures and pre-canvas call sites don't break.
  sourceNodeId?: string | null;
  // Canvas spatial cards only: id of the canvas edge this card was generated from.
  edgeId?: string | null;

  // Table rows capture their headers/cells/row-tags so a tag-bound template can
  // be merged at render time. Null for non-table cards.
  templateRow?: TemplateRow | null;

  // Anchor binding key currently present in the source file; null until the
  // card is stamped (the durable record lives in anchor_bindings).
  anchor?: string | null;

  state: FlashcardState;
  dueDate: string;
  interval: number; // in minutes
  repetitions: number;
  difficulty: number; // FSRS difficulty value (1-10)
  stability: number; // FSRS stability value
  lapses: number; // Number of times card was forgotten
  lastReviewed: string | null; // Last review date
  // Card-state overlays. Both are nullable; default NULL means "not suspended"
  // and "not buried". `suspendedAt` is a deliberate user assertion (indefinite
  // freeze) — preserved across deck-resets. `buriedUntil` is a wall-clock
  // expiry (typically next-day rollover) and auto-clears via scheduler WHERE
  // clauses comparing against now.
  suspendedAt: string | null;
  buriedUntil: string | null;
  created: string;
  modified: string;
}

export interface ReviewSession {
  id: string;
  deckId: string;
  startedAt: string; // ISO datetime
  endedAt: string | null; // ISO datetime when user closes session, can be null
  goalTotal: number; // COUNT(dueAt <= now) at session start; if limits defined take Top LimitAmount
  doneUnique: number; // unique number of cards seen
}

export type CramRating = "again" | "good";

export type CramDeckKind = "file" | "group" | "custom";

/**
 * A cram (drill) run over a deck. Cram scheduling is isolated from real FSRS
 * state — it writes no review_logs and never mutates flashcards. Per-card
 * temporary state lives in CramCard rows tied to this session.
 */
export interface CramSession {
  id: string;
  deckKey: string; // FileDeck.id | DeckGroup.tag | CustomDeckGroup.id
  deckKind: CramDeckKind;
  startedAt: string;
  endedAt: string | null;
  goalTotal: number; // number of cards enrolled
  graduatedCount: number; // cards that reached a >= 1 day interval
  created: string;
  modified: string;
}

/**
 * Ephemeral per-card scheduling state within a cram session. Seeded fresh
 * ("drill from scratch") and advanced only by cram ratings; a card graduates
 * (leaves the queue) once temp_interval reaches >= 1 day.
 */
export interface CramCard {
  id: string; // `${sessionId}:${flashcardId}`
  sessionId: string;
  flashcardId: string;
  tempState: FlashcardState;
  tempStability: number;
  tempDifficulty: number;
  tempInterval: number; // in minutes
  tempDueAt: string; // next in-session show time
  reps: number;
  graduatedAt: string | null; // set once tempInterval >= 1440
  created: string;
  modified: string;
}

export interface ReviewLog {
  id: string;
  flashcardId: string;
  sessionId?: string; // Reference to review session (no cascade delete)

  // Timestamps
  lastReviewedAt: string; // before this review
  shownAt?: string; // when card was shown (optional)
  reviewedAt: string; // when rating was recorded

  // Rating
  rating: 1 | 2 | 3 | 4; // Again=1, Hard=2, Good=3, Easy=4
  ratingLabel: "again" | "hard" | "good" | "easy";
  timeElapsedMs?: number; // if not deriving from shownAt

  // Pre-state (for exact reconstruction)
  oldState: "new" | "review";
  oldRepetitions: number;
  oldLapses: number;
  oldStability: number;
  oldDifficulty: number;

  // Post-state
  newState: "new" | "review"; // will be "review" in pure FSRS
  newRepetitions: number;
  newLapses: number;
  newStability: number;
  newDifficulty: number;

  // Intervals & due times (explicit units)
  oldIntervalMinutes: number;
  newIntervalMinutes: number;
  oldDueAt: string;
  newDueAt: string;

  // Derived at review time
  elapsedDays: number; // (reviewedAt - lastReviewedAt) / 86400000
  retrievability: number; // R

  // Config snapshot (profile is a point-in-time snapshot, so it may carry legacy "INTENSIVE")
  requestRetention: number;
  profile: "INTENSIVE" | "STANDARD" | "TRAINED";
  maximumIntervalDays: number;
  minMinutes: number;
  fsrsWeightsVersion: string; // or weightsHash
  schedulerVersion: string;

  // Optional content/context
  noteModelId?: string;
  cardTemplateId?: string;
  contentHash?: string;
  client?: "web" | "desktop" | "mobile";

  // Trained weight set used for this review (TRAINED profile only; null for shipped weights)
  fsrsWeightSetId?: string | null;
}

/**
 * A single applied FSRS weight-optimization run. The DB keeps every set (history); the
 * active one is the newest live row by `trainedAt`.
 */
export interface FsrsWeightSet {
  id: string;
  weights: number[];
  trainedAt: string;
  reviewsTrained: number;
  cardsTrained: number;
  beforeLogLoss: number | null;
  afterLogLoss: number | null;
  steps: number;
  durationMs: number;
  weightsVersion: string;
  created: string;
  modified: string;
  deletedAt?: string | null;
}

export interface DeckStats {
  deckId: string;
  newCount: number;
  dueCount: number;
  totalCount: number;
  matureCount: number;
}

export interface AnkiExportConfig {
  noteType: string;
  tags: string[];
  ankiDeckName: string;
  separator: string;
}

export interface DatabaseSchema {
  decks: Deck;
  deckprofiles: DeckProfile;
  profile_tag_mappings: ProfileTagMapping;
  flashcards: Flashcard;
  review_logs: ReviewLog;
  review_sessions: ReviewSession;
  custom_decks: CustomDeck;
  custom_deck_cards: CustomDeckCard;
  fsrs_weight_sets: FsrsWeightSet;
}

export interface DailyStats {
  date: string;
  reviews: number;
  timeSpent: number;
  newCards: number;
  learningCards: number;
  reviewCards: number;
  correctRate: number;
}

export interface CardStats {
  new: number;
  review: number;
  mature: number;
  total: number;
}

export interface ReviewStats {
  totalReviews: number;
  totalTimeMs: number;
}

export interface AnswerButtons {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface IntervalData {
  interval: string;
  count: number;
}

export interface ForecastData {
  date: string;
  dueCount: number;
  count: number; // Alias for dueCount for backwards compatibility
}

export interface Statistics {
  dailyStats: DailyStats[];
  cardStats: CardStats;
  reviewStats: ReviewStats;
  answerButtons: AnswerButtons;
  retentionRate: number;
  intervals: IntervalData[];
  forecast: ForecastData[];
  averagePace: number; // Average seconds per card
  totalReviewTime: number; // Total time spent reviewing in seconds
}

export interface SimulatedCardState {
  id: string;
  deckId: string;
  state: "new" | "review";
  stability: number;
  difficulty: number;
  dueDate: number; // milliseconds - when card becomes due
  lastReviewedDate: number; // milliseconds - when card was last reviewed (for elapsed time calculation)
  repetitions: number;
  lapses: number;
}

/**
 * Result of maturity progression simulation with equilibrium detection
 */
export interface MaturityProgressionResult {
  dailySnapshots: Array<{
    date: string;
    newCards: number;
    learningCards: number;
    matureCards: number;
  }>;
  maintenanceLevel: number | null; // Percentage (0-100) of total cards in perpetual learning phase
  equilibriumDetectedAt: number | null; // Day index when equilibrium was first detected
  totalCards: number; // Total card count for context
  empiricalLapseRate: number; // Actual lapse rate from button distribution (0-1)
  theoreticalMaintenanceLevel: number | null; // Calculated from lapse rate for validation
}


/**
 * Determine if a flashcard is mature (interval > 21 days)
 * TODO 19: Mature cards are flashcards that have an interval over 21 days
 */
export function isCardMature(flashcard: Flashcard): boolean {
  const MATURE_THRESHOLD_MINUTES = 21 * 24 * 60; // 21 days in minutes = 30,240
  return (
    flashcard.state === "review" &&
    flashcard.interval > MATURE_THRESHOLD_MINUTES
  );
}

/**
 * Get the card maturity type for classification
 */
export function getCardMaturityType(
  flashcard: Flashcard
): "new" | "review" | "mature" {
  if (flashcard.state === "new") {
    return "new";
  }
  return isCardMature(flashcard) ? "mature" : "review";
}

export function isCardSuspended(card: Pick<Flashcard, "suspendedAt">): boolean {
  return card.suspendedAt !== null && card.suspendedAt !== undefined;
}

export function isCardBuried(
  card: Pick<Flashcard, "buriedUntil">,
  now: Date
): boolean {
  if (!card.buriedUntil) return false;
  return card.buriedUntil > now.toISOString();
}

export function isCardAvailable(
  card: Pick<Flashcard, "suspendedAt" | "buriedUntil">,
  now: Date
): boolean {
  return !isCardSuspended(card) && !isCardBuried(card, now);
}
