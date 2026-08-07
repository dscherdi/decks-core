import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import type { ProviderCompleteRequest } from "./providers/AiProvider";
import {
  buildGenerationMessages,
  GenerationStreamParser,
  COVERED_MARKER,
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
  /** True when the model hit its output-token limit (finish_reason "length"). */
  truncated?: boolean;
  /**
   * The model reported the source exhausted. A hint, not a verdict — it stops
   * the batch loop early rather than preventing another run.
   */
  covered?: boolean;
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
    // Some providers assemble the request server-side: send raw materials instead
    // of an assembled system/user.
    const serverSide = provider.buildsPromptServerSide?.() === true;
    const { system, user, priorAssistant, followupUser } = serverSide
      ? { system: "", user: "", priorAssistant: undefined, followupUser: undefined }
      : buildGenerationMessages(req);
    const baseReq: Omit<ProviderCompleteRequest, "signal"> = serverSide
      ? {
          system: "",
          user: "",
          rawSource: req.sourceContext,
          rawPrompt: req.prompt,
          rawGeneratedSoFar: req.generatedSoFar,
          category: req.category,
          images: req.images,
          json: false,
        }
      : { system, user, priorAssistant, followupUser, images: req.images, json: false };

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
      // When the request is assembled server-side, show the raw materials instead.
      system: serverSide ? "(built server-side)" : system,
      user: serverSide ? req.sourceContext ?? req.prompt : user,
      priorAssistant: serverSide
        ? req.generatedSoFar?.length
          ? `${req.generatedSoFar.length} prior card(s)`
          : undefined
        : priorAssistant,
      followupUser: serverSide ? req.prompt : followupUser,
      imageCount: req.images?.length ?? 0,
      raw,
    });

    if (provider.completeStream) {
      // Declared outside the try so the catch can surface what streamed so far.
      let streamedRaw = "";
      try {
        const parser = new GenerationStreamParser();
        const streamRes = await provider.completeStream(
          { ...baseReq, signal },
          (delta) => {
            streamedRaw += delta;
            const { completed, partial } = parser.push(delta);
            for (const c of completed) emit(c);
            handlers.onPartial?.(partial);
          },
        );
        const truncated = streamRes?.finishReason === "length";
        // When the response was cut off by the output-token limit, the trailing
        // card (no closing ===END===) is incomplete — drop it; the next batch
        // re-generates it cleanly.
        const tail = parser.finish();
        if (tail && !truncated) emit(tail);
        handlers.onPartial?.(null);
        return {
          cards,
          truncated,
          covered: parser.covered,
          debug: req.debug ? makeDebug(streamedRaw) : undefined,
        };
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
      raw = await provider.complete({ ...baseReq, signal });
    } catch (e) {
      if (req.debug && e instanceof AiError) {
        e.debug = { system, user, raw: "" };
      }
      throw e;
    }
    for (const c of parseGeneratedCards(raw)) emit(c);
    handlers.onPartial?.(null);
    return {
      cards,
      covered: raw.includes(COVERED_MARKER),
      debug: req.debug ? makeDebug(raw) : undefined,
    };
  }
}
