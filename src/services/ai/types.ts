/**
 * Provider-agnostic types for AI flashcard refactoring. The editable-field
 * union deliberately mirrors the plugin's `FlashcardEdits` field-for-field so
 * converting an accepted proposal into a FlashcardWriter edit is an identity map.
 */
export type AiProviderId = "gemini" | "openai" | "claude" | "openai-compatible";

export interface AiProviderConfig {
  provider: AiProviderId;
  model: string;
  /** Required for hosted providers; optional for openai-compatible/local. */
  apiKey?: string;
  /** Base URL for openai-compatible providers (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
}

export type RefactorFieldSet =
  | { type: "header-paragraph"; front: string; back: string }
  | { type: "table"; front: string; back: string; notes: string }
  | { type: "cloze"; front: string; sentence: string }
  | { type: "image-occlusion"; listItem: string }
  | { type: "spatial"; front: string; back: string; hint: string };

export type RefactorCardType = RefactorFieldSet["type"];

/** Editable field keys per card type — the exact keys the model must return. */
export const REFACTOR_FIELD_KEYS: Record<RefactorCardType, string[]> = {
  "header-paragraph": ["front", "back"],
  table: ["front", "back", "notes"],
  cloze: ["front", "sentence"],
  "image-occlusion": ["listItem"],
  spatial: ["front", "back", "hint"],
};

export interface RefactorRequest {
  /** Per-DeckProfile prompt template guiding the refactor. */
  prompt: string;
  /** Current editable values for the card. */
  current: RefactorFieldSet;
}

export interface RefactorProposal {
  key: string;
  before: string;
  after: string;
}

export interface RefactorResult {
  /** Full proposed field set (same discriminant as the request). */
  proposed: RefactorFieldSet;
  /** Only the fields the model actually changed. */
  proposals: RefactorProposal[];
}

export type AiErrorCode =
  | "missing_key"
  | "network_error"
  | "provider_error"
  | "invalid_output"
  | "rate_limited"
  | "aborted";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;

  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = status;
  }
}
