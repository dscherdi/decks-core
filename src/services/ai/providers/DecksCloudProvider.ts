import { DECKS_CLOUD_DEFAULT_BASE_URL } from "../models";
import { AiError } from "../types";
import { OpenAiProvider } from "./OpenAiProvider";

/**
 * Hosted Decks Cloud proxy. Wire-compatible with OpenAI chat-completions, but
 * posts to the Worker's /api/generate and authenticates with a license key
 * (carried by config.apiKey -> Authorization: Bearer, inherited from the base).
 */
export class DecksCloudProvider extends OpenAiProvider {
  protected endpoint(): string {
    const base = (this.config.baseUrl?.trim() || DECKS_CLOUD_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!base) {
      throw new AiError("provider_error", "No Decks Cloud server URL configured");
    }
    return `${base}/api/generate`;
  }

  // Open-weights models behind OpenRouter don't reliably support response_format.
  protected useJsonResponseFormat(): boolean {
    return false;
  }
}
