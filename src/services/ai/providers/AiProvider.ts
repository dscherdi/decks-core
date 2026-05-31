import type { AiProviderId } from "../types";

/**
 * A provider is responsible only for transport + wire format: take a system
 * and user message, return the raw model text. Prompt construction and JSON
 * parsing live in the orchestrator so they are shared across providers.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  complete(system: string, user: string, signal?: AbortSignal): Promise<string>;
}
