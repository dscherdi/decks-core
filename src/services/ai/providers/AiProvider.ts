import type { AiProviderId, RefactorImage, RefactorRequest } from "../types";
import type { CritiqueCard } from "../critique-prompt";
import type { GeneratedCard } from "../generation-prompt";
import type { ExamJudgeItem } from "../../ExamAttempt";

/** Transport-level request: the built messages plus optional image attachments. */
export interface ProviderCompleteRequest {
  system: string;
  /**
   * First user message. For caching this should be the static block (e.g. the
   * source notes) so the system+user prefix stays byte-identical across calls.
   */
  user: string;
  /**
   * Optional assistant turn carrying dynamic context (e.g. the cards generated
   * so far). Inserted AFTER the static prefix so it never invalidates the cache.
   */
  priorAssistant?: string;
  /**
   * Optional trailing user turn (e.g. the instruction + "continue" trigger).
   * Kept separate from `user` so the cacheable prefix excludes it.
   */
  followupUser?: string;
  images?: RefactorImage[];
  signal?: AbortSignal;
  /**
   * Whether to ask the provider for strict JSON output. Defaults to the
   * provider's own default (on for hosted refactoring). Generation sets this to
   * `false` because its output is delimited text, not JSON.
   */
  json?: boolean;
  /**
   * Raw materials sent when the provider assembles the request server-side
   * (instead of an assembled system/user). Set by AiGenerationService when the
   * provider reports `buildsPromptServerSide()`.
   */
  rawSource?: string;
  rawPrompt?: string;
  rawGeneratedSoFar?: GeneratedCard[];
  /** The round a refining instruction replaces, for the server-side prompt. */
  rawRefining?: GeneratedCard[];
  /** Raw refactor request sent when the server assembles the refactor prompt. */
  rawRefactor?: RefactorRequest;
  /** Cards to be judged, for the server-side critique pass. */
  rawCritique?: CritiqueCard[];
  /** What the run is producing, for the server-side prompt. */
  rawCardType?: string;
  /** Page-labelled source for the server-side concept extraction. */
  rawConceptSource?: string;
  /** A question and its grounding, for the server-side answer. */
  rawChat?: {
    question: string;
    source: string;
    staged: string[];
    uncovered: string[];
    deck: string[];
    history: Array<{ question: string; answer: string }>;
  };
  /** Typed exam answers for the backend to judge by meaning. */
  rawGrade?: ExamJudgeItem[];
  /** Concepts and cards for the backend to map. */
  rawConceptMap?: {
    concepts: Array<{ id: string; term: string; page: number; blurb?: string }>;
    cards: Array<{ id: string; front: string; back: string; page?: number }>;
  };
  /** Card pairs for the backend to check for the same fact. */
  rawOverlap?: Array<{ id: string; a: { front: string; back: string }; b: { front: string; back: string } }>;
  /** Optional routing-category hint passed through with the request. */
  category?: string;
}

export interface CompleteResult {
  text: string;
  finishReason?: string;
}

/** What a stream reports besides the answer text. All optional, so any provider may ignore them. */
export interface StreamEvents {
  /** Thinking text, where the model streams it. Never part of the answer. */
  onReasoning?(text: string): void;
  /** A step the server reports before the model starts. */
  onServerStage?(stage: { step: string; done?: number; total?: number }): void;
  /** Any bytes at all, keep-alives included. */
  onActivity?(): void;
}

/** How long a stream may stay silent: before its first byte, and between bytes. */
export interface StreamTimeouts {
  firstByteMs: number;
  idleMs: number;
}

/** Metadata a streaming completion reports when it finishes. */
export interface StreamResult {
  /**
   * The provider's stop reason, normalized so truncation by the output-token
   * limit is reported as `"length"` (OpenAI's value) across providers.
   */
  finishReason?: string;
}

/**
 * A provider is responsible only for transport + wire format: take the built
 * system/user messages (and any image attachments), return the raw model text.
 * Prompt construction and JSON parsing live in the orchestrator so they are
 * shared across providers.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  complete(req: ProviderCompleteRequest): Promise<string>;
  /** `complete`, also saying why the reply ended; "length" means it was cut off. */
  completeWithMeta?(req: ProviderCompleteRequest): Promise<CompleteResult>;
  /**
   * Whether this provider assembles the request server-side. When true the
   * orchestrator skips client-side message building and sends the raw materials
   * (`rawSource`/`rawPrompt`/`rawGeneratedSoFar`) for the server to assemble.
   */
  buildsPromptServerSide?(): boolean;
  /**
   * Optional streaming variant: emits model text deltas via `onDelta` as they
   * arrive and resolves (with the finish reason) when the response completes.
   * Absent (or throwing) means the caller should fall back to `complete()`.
   */
  completeStream?(
    req: ProviderCompleteRequest,
    onDelta: (text: string) => void,
    events?: StreamEvents,
  ): Promise<StreamResult>;
  /**
   * Whether a stream that failed before its first byte may be retried without
   * streaming. False where a second attempt would run the whole generation again.
   */
  allowsNonStreamingFallback?(): boolean;
  /** Silence limits for this provider's streams. */
  streamTimeouts?(): StreamTimeouts;
}
