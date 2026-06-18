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
    // OCR: send only the image(s); the server builds the OCR messages.
    if (this.config.model.startsWith("decks-ocr-")) {
      return {
        model: this.config.model,
        images: req.images?.map((im) => ({
          mimeType: im.mimeType,
          dataBase64: im.dataBase64,
        })),
      };
    }
    // Refactor: send the raw request; the server builds the messages.
    if (req.rawRefactor) {
      const r = req.rawRefactor;
      return {
        model: this.config.model,
        refactor: {
          current: r.current,
          instructions: r.instructions,
          targetKeys: r.targetKeys,
          sourceContext: r.sourceContext,
          split: !!r.split,
        },
        images: req.images?.map((im) => ({
          mimeType: im.mimeType,
          dataBase64: im.dataBase64,
        })),
      };
    }
    // Raw mode (generation): send raw materials; the server builds the messages.
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
