import type { AiProviderId, RefactorImage, RefactorRequest } from "../types";
import type { GeneratedCard } from "../generation-prompt";

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
  /** Raw refactor request sent when the server assembles the refactor prompt. */
  rawRefactor?: RefactorRequest;
  /** Optional routing-category hint passed through with the request. */
  category?: string;
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
  ): Promise<StreamResult>;
}
