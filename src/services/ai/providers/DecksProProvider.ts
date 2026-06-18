import { DECKS_PRO_DEFAULT_BASE_URL } from "../models";
import { AiError } from "../types";
import { OpenAiProvider } from "./OpenAiProvider";
import type { ProviderCompleteRequest } from "./AiProvider";

/**
 * Hosted Decks Pro provider. Wire-compatible with OpenAI chat-completions, but
 * posts to the Decks Pro backend's /api/generate and authenticates with a license
 * key (carried by config.apiKey -> Authorization: Bearer, inherited from the base).
 */
export class DecksProProvider extends OpenAiProvider {
  protected endpoint(): string {
    const base = (this.config.baseUrl?.trim() || DECKS_PRO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!base) {
      throw new AiError("provider_error", "No Decks Pro server URL configured");
    }
    return `${base}/api/generate`;
  }

  // The hosted models don't reliably support response_format.
  protected useJsonResponseFormat(): boolean {
    return false;
  }

  // The server assembles the generation request from raw materials.
  buildsPromptServerSide(): boolean {
    return true;
  }

  protected buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
    // Raw mode (generation): send raw materials; the server builds the messages.
    // OCR and other non-raw calls fall through to the normal OpenAI body.
    if (req.rawSource !== undefined || req.rawPrompt !== undefined) {
      return {
        model: this.config.model,
        source: req.rawSource ?? "",
        prompt: req.rawPrompt ?? "",
        generatedSoFar: req.rawGeneratedSoFar,
        images: req.images?.map((im) => ({
          mimeType: im.mimeType,
          dataBase64: im.dataBase64,
        })),
        category: req.category,
      };
    }
    return super.buildBody(req);
  }
}
