import type { AiProviderId, RefactorImage } from "../types";

/** Transport-level request: the built messages plus optional image attachments. */
export interface ProviderCompleteRequest {
  system: string;
  user: string;
  images?: RefactorImage[];
  signal?: AbortSignal;
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
}
