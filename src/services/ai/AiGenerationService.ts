import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import {
  buildGenerationMessages,
  GenerationStreamParser,
  parseGeneratedCards,
  type GeneratedCard,
  type GenerateRequest,
} from "./generation-prompt";
import type { AiProviderConfig } from "./types";
import { AiError } from "./types";

/** Callbacks invoked as cards stream in. */
export interface GenerateHandlers {
  /** Called once per completed card. */
  onCard: (card: GeneratedCard) => void;
  /** Called with the card currently being streamed (or null when none). */
  onPartial?: (card: GeneratedCard | null) => void;
}

export interface GenerateResult {
  cards: GeneratedCard[];
  /** The exact prompt sent and raw text received — only when `debug` was set. */
  debug?: { system: string; user: string; raw: string };
}

/**
 * Provider-agnostic orchestrator for AI flashcard generation. Streams cards via
 * the provider's `completeStream` when available, parsing the delimited
 * `FRONT:/BACK:/NOTES:/===END===` format incrementally; falls back to a single
 * non-streaming `complete()` call (then parses the whole response) when the
 * provider has no streaming or browser streaming fails before any card arrives.
 */
export class AiGenerationService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  async generateStream(
    config: AiProviderConfig,
    req: GenerateRequest,
    handlers: GenerateHandlers,
    signal?: AbortSignal,
  ): Promise<GenerateResult> {
    if (config.provider !== "openai-compatible" && !config.apiKey) {
      throw new AiError("missing_key", "No API key configured for this provider");
    }

    const provider = createProvider(config, this.http);
    const { system, user } = buildGenerationMessages(req);

    this.logger?.debug(
      `AI generation via ${config.provider} (${config.model})`,
    );
    this.logger?.debug(`AI generation system:\n${system}`);
    this.logger?.debug(`AI generation user:\n${user}`);
    if (req.images?.length) {
      this.logger?.debug(
        `AI generation images: ${req.images.length} (${req.images
          .map((im) => im.mimeType)
          .join(", ")})`,
      );
    }

    const cards: GeneratedCard[] = [];
    const emit = (card: GeneratedCard): void => {
      cards.push(card);
      handlers.onCard(card);
    };

    if (provider.completeStream) {
      try {
        const parser = new GenerationStreamParser();
        let raw = "";
        await provider.completeStream(
          { system, user, images: req.images, signal, json: false },
          (delta) => {
            raw += delta;
            const { completed, partial } = parser.push(delta);
            for (const c of completed) emit(c);
            handlers.onPartial?.(partial);
          },
        );
        const tail = parser.finish();
        if (tail) emit(tail);
        handlers.onPartial?.(null);
        return { cards, debug: req.debug ? { system, user, raw } : undefined };
      } catch (e) {
        // Re-throw cancellations and any partial-progress failures; otherwise
        // (e.g. browser streaming blocked by CORS before any card) fall back to
        // the non-streaming path below.
        if (e instanceof AiError && e.code === "aborted") throw e;
        if (signal?.aborted || cards.length > 0) throw e;
        this.logger?.debug(
          `AI generation streaming failed, falling back to non-streaming: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    let raw: string;
    try {
      raw = await provider.complete({
        system,
        user,
        images: req.images,
        signal,
        json: false,
      });
    } catch (e) {
      if (req.debug && e instanceof AiError) {
        e.debug = { system, user, raw: "" };
      }
      throw e;
    }
    for (const c of parseGeneratedCards(raw)) emit(c);
    handlers.onPartial?.(null);
    return { cards, debug: req.debug ? { system, user, raw } : undefined };
  }
}
