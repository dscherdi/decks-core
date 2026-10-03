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
    // Matches every OCR sentinel, tiered or not — the prefix must stay looser
    // than the values in models.ts, or an OCR call silently falls through to the
    // generic body and reaches the server with no images at all.
    if (this.config.model.startsWith("decks-ocr")) {
      return {
        model: this.config.model,
        images: req.images?.map((im) => ({
          mimeType: im.mimeType,
          dataBase64: im.dataBase64,
        })),
      };
    }
    // Concepts: send the labelled source; the server builds the rubric.
    if (req.rawConceptSource !== undefined) {
      return { model: this.config.model, concepts: { source: req.rawConceptSource } };
    }
    // Grading: send the typed answers; the backend judges them.
    if (req.rawGrade) {
      return { model: this.config.model, grade: { items: req.rawGrade } };
    }
    if (req.rawConceptMap) {
      return { model: this.config.model, conceptMap: req.rawConceptMap };
    }
    if (req.rawOverlap) {
      return { model: this.config.model, overlap: { pairs: req.rawOverlap } };
    }
    // Chat: send the question and its grounding; the server builds the rubric.
    if (req.rawChat) {
      return { model: this.config.model, chat: req.rawChat };
    }
    // Critique: send the cards to be judged; the server builds the rubric.
    if (req.rawCritique) {
      return {
        model: this.config.model,
        cardType: req.rawCardType,
        critique: {
          cards: req.rawCritique.map(({ id, card }) => ({
            id,
            front: card.front,
            back: card.back,
            notes: card.notes,
          })),
        },
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
        refining: req.rawRefining,
        images: req.images?.map((im) => ({
          mimeType: im.mimeType,
          dataBase64: im.dataBase64,
        })),
        category: req.category,
        cardType: req.rawCardType,
      };
    }
    return super.buildBody(req);
  }
}
