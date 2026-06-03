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

/** A base64-encoded image attached as context, sent to vision-capable models. */
export interface RefactorImage {
  /** MIME type, e.g. "image/png" or "image/jpeg". */
  mimeType: string;
  /** Raw base64 of the image bytes (no data: prefix). */
  dataBase64: string;
}

export interface RefactorRequest {
  /** Per-DeckProfile prompt template guiding the refactor. */
  prompt: string;
  /** Current editable values for the card. */
  current: RefactorFieldSet;
  /** Extra user instructions (custom text + selected presets), appended to the prompt. */
  instructions?: string;
  /**
   * Subset of this card type's field keys the model may change. Other fields are
   * still sent as context but must not be modified. Undefined = all fields mutable.
   */
  targetKeys?: string[];
  /** Clipped source-note window (markdown), attached note text, or canvas node text. */
  sourceContext?: string;
  /** Image attachments to send as context (requires a vision-capable model). */
  images?: RefactorImage[];
  /** When true, ask the model to split this card into multiple smaller cards. */
  split?: boolean;
  /** When true, the built messages + raw response are attached to the result/error for debugging. */
  debug?: boolean;
}

export interface RefactorProposal {
  key: string;
  before: string;
  after: string;
}

/** The exact prompt sent and raw text received — populated only when debugging. */
export interface RefactorDebugInfo {
  system: string;
  user: string;
  raw: string;
}

export interface RefactorResult {
  /** Full proposed field set (same discriminant as the request). */
  proposed: RefactorFieldSet;
  /** Only the fields the model actually changed. */
  proposals: RefactorProposal[];
  /** Present only for split requests: the card broken into multiple new cards. */
  splitCards?: RefactorFieldSet[];
  /** Present only when the request set `debug: true`. */
  debug?: RefactorDebugInfo;
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
  /** Set by the orchestrator on failure when debugging, so callers can show the exchange. */
  debug?: RefactorDebugInfo;

  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = status;
  }
}
