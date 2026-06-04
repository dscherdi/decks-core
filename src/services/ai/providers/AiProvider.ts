import type { AiProviderId, RefactorImage } from "../types";

/** Transport-level request: the built messages plus optional image attachments. */
export interface ProviderCompleteRequest {
  system: string;
  user: string;
  images?: RefactorImage[];
  signal?: AbortSignal;
  /**
   * Whether to ask the provider for strict JSON output. Defaults to the
   * provider's own default (on for hosted refactoring). Generation sets this to
   * `false` because its output is delimited text, not JSON.
   */
  json?: boolean;
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
   * Optional streaming variant: emits model text deltas via `onDelta` as they
   * arrive and resolves when the response completes. Absent (or throwing) means
   * the caller should fall back to `complete()`.
   */
  completeStream?(
    req: ProviderCompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<void>;
}
