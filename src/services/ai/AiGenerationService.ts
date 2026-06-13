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

/** Structured request payload + raw response, attached only when `debug` was set. */
export interface GenerateDebugInfo {
  provider: string;
  model: string;
  system: string;
  user: string;
  priorAssistant?: string;
  followupUser?: string;
  imageCount: number;
  raw: string;
}

export interface GenerateResult {
  cards: GeneratedCard[];
  /** The exact prompt sent and raw text received — only when `debug` was set. */
  debug?: GenerateDebugInfo;
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
    const { system, user, priorAssistant, followupUser } =
      buildGenerationMessages(req);

    this.logger?.debug(
      `AI generation via ${config.provider} (${config.model})`,
    );
    this.logger?.debug(`AI generation system:\n${system}`);
    this.logger?.debug(`AI generation user:\n${user}`);
    if (priorAssistant) {
      this.logger?.debug(`AI generation prior assistant:\n${priorAssistant}`);
    }
    if (followupUser) {
      this.logger?.debug(`AI generation followup user:\n${followupUser}`);
    }
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

    const makeDebug = (raw: string): GenerateDebugInfo => ({
      provider: config.provider,
      model: config.model,
      system,
      user,
      priorAssistant,
      followupUser,
      imageCount: req.images?.length ?? 0,
      raw,
    });

    if (provider.completeStream) {
      // Declared outside the try so the catch can surface what streamed so far.
      let streamedRaw = "";
      try {
        const parser = new GenerationStreamParser();
        await provider.completeStream(
          {
            system,
            user,
            priorAssistant,
            followupUser,
            images: req.images,
            signal,
            json: false,
          },
          (delta) => {
            streamedRaw += delta;
            const { completed, partial } = parser.push(delta);
            for (const c of completed) emit(c);
            handlers.onPartial?.(partial);
          },
        );
        const tail = parser.finish();
        if (tail) emit(tail);
        handlers.onPartial?.(null);
        return { cards, debug: req.debug ? makeDebug(streamedRaw) : undefined };
      } catch (e) {
        // User pressed Stop: surface what streamed so far (incl. debug) rather
        // than failing, so the debug panel can show the partial exchange.
        if (signal?.aborted || (e instanceof AiError && e.code === "aborted")) {
          handlers.onPartial?.(null);
          return {
            cards,
            debug: req.debug ? makeDebug(streamedRaw) : undefined,
          };
        }
        // A mid-stream failure that already produced cards is a real error;
        // otherwise (e.g. browser streaming blocked by CORS before any card)
        // fall back to the non-streaming path below.
        if (cards.length > 0) throw e;
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
        priorAssistant,
        followupUser,
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
    return { cards, debug: req.debug ? makeDebug(raw) : undefined };
  }
}
