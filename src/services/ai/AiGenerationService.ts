import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import type { ProviderCompleteRequest } from "./providers/AiProvider";
import {
  buildGenerationMessages,
  GenerationStreamParser,
  COVERED_MARKER,
  parseGeneratedCards,
  PRIOR_CARD_LIMIT,
  type GeneratedCard,
  type GenerateRequest,
} from "./generation-prompt";
import type { AiProviderConfig } from "./types";
import { AiError } from "./types";
import { SILENT_THINKING_MS, type GenerationStage } from "./stages";
import { repairCardFormat } from "./format-check";

/** Callbacks invoked as cards stream in. */
export interface GenerateHandlers {
  /** Called once per completed card. */
  onCard: (card: GeneratedCard) => void;
  /** Called with the card currently being streamed (or null when none). */
  onPartial?: (card: GeneratedCard | null) => void;
  /** Where the request is, before and while cards arrive. */
  onStage?: (stage: GenerationStage) => void;
  /** Thinking text, where the model streams it. */
  onReasoning?: (text: string) => void;
}

/** Thinking kept for the debug view, so a long trace cannot grow without bound. */
const DEBUG_REASONING_CHARS = 50_000;

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
  /** What the model thought before answering, where it streamed it. */
  reasoning?: string;
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

/** A run of rounds: one request, fed its own output until it has nothing new to add. */
export interface GenerateRoundsRequest extends Omit<GenerateRequest, "generatedSoFar"> {
  /** Cards already on the table: fed back so the model continues, never re-emitted. */
  existingCards?: GeneratedCard[];
  /** Upper bound on rounds; a refinement always runs one. */
  maxBatches?: number;
}

/** A part of the source generated in one request, read when its turn comes. */
export interface SourceChunk {
  pages: number[];
  label: string;
  /** The chunk's source text; "" when its pages hold none. */
  load: () => Promise<string>;
}

export interface GenerateChunkedRequest
  extends Omit<GenerateRoundsRequest, "sourceContext" | "maxBatches" | "refining"> {
  chunks: SourceChunk[];
  /** Other source text, such as an attached note, sent with the first chunk only, as are images. */
  extraContext?: string;
}

export interface GenerateChunkedResult extends GenerateResult {
  /** Chunks generated before the run ended. */
  doneChunks: number;
  /** Chunks whose pages held no text. */
  emptyChunks: number;
  /** What ended the run early once cards had arrived; they are kept. */
  error?: unknown;
}

/** Normalized key for in-run dedup (no deck exists yet to hash against). */
function cardKey(card: GeneratedCard): string {
  return card.front.trim().toLowerCase();
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
          rawRefining: req.refining,
          rawCardType: req.cardType,
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
    // Repaired as it arrives, so a stored card never holds a fault the repair can fix.
    const emit = (card: GeneratedCard): void => {
      const fixed = repairCardFormat(card);
      cards.push(fixed);
      handlers.onCard(fixed);
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
      let reasoning = "";
      let heard = false;
      let thinkingSince: number | null = null;
      const think = (): void => {
        if (thinkingSince !== null || streamedRaw) return;
        thinkingSince = Date.now();
        handlers.onStage?.({ kind: "thinking", since: thinkingSince });
      };
      // A model that thinks without streaming its thoughts still keeps the line open.
      const silentThinking = setTimeout(think, SILENT_THINKING_MS);
      handlers.onStage?.({ kind: "sending" });
      try {
        const parser = new GenerationStreamParser();
        const streamRes = await provider.completeStream(
          { ...baseReq, signal },
          (delta) => {
            if (!streamedRaw) handlers.onStage?.({ kind: "writing", card: cards.length + 1 });
            streamedRaw += delta;
            const { completed, partial } = parser.push(delta);
            for (const c of completed) {
              emit(c);
              handlers.onStage?.({ kind: "writing", card: cards.length + 1 });
            }
            handlers.onPartial?.(partial);
          },
          {
            onActivity: () => {
              heard = true;
            },
            onReasoning: (text) => {
              think();
              if (req.debug && reasoning.length < DEBUG_REASONING_CHARS) reasoning += text;
              handlers.onReasoning?.(text);
            },
            onServerStage: (stage) => handlers.onStage?.({ kind: "server", ...stage }),
          },
        );
        clearTimeout(silentThinking);
        const truncated = streamRes?.finishReason === "length";
        // When the response was cut off by the output-token limit, the trailing
        // card (no closing ===END===) is incomplete — drop it; the next batch
        // re-generates it cleanly.
        const tail = parser.finish();
        for (const c of truncated ? tail.slice(0, -1) : tail) emit(c);
        handlers.onPartial?.(null);
        return {
          cards,
          truncated,
          covered: parser.covered,
          debug: req.debug ? { ...makeDebug(streamedRaw), reasoning: reasoning || undefined } : undefined,
        };
      } catch (e) {
        clearTimeout(silentThinking);
        // User pressed Stop: surface what streamed so far (incl. debug) rather
        // than failing, so the debug panel can show the partial exchange.
        if (signal?.aborted || (e instanceof AiError && e.code === "aborted")) {
          handlers.onPartial?.(null);
          return {
            cards,
            debug: req.debug ? { ...makeDebug(streamedRaw), reasoning: reasoning || undefined } : undefined,
          };
        }
        // Retry without streaming only where streaming itself failed (e.g. blocked
        // by CORS): never after a byte, a status, a silence, or where it would run twice.
        const transportFailed = e instanceof AiError && e.code === "network_error";
        if (cards.length > 0 || heard || !transportFailed || provider.allowsNonStreamingFallback?.() === false) {
          throw e;
        }
        this.logger?.debug(
          `AI generation streaming failed, falling back to non-streaming: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        handlers.onStage?.({ kind: "retrying" });
      }
    } else {
      handlers.onStage?.({ kind: "sending" });
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

  /**
   * Generate in rounds. Each round feeds the cards produced so far back as an
   * assistant turn; the run stops when a round adds nothing and was not cut off,
   * when the model says the source is spent, or at the cap.
   */
  async generateRounds(
    config: AiProviderConfig,
    req: GenerateRoundsRequest,
    handlers: GenerateHandlers,
    signal?: AbortSignal,
  ): Promise<GenerateResult> {
    const { existingCards, maxBatches: cap, ...base } = req;
    // A refinement returns one replacement set; another round would only repeat it.
    const maxBatches = req.refining?.length ? 1 : Math.max(1, cap ?? 1);
    const priorContext: GeneratedCard[] = [...(existingCards ?? [])];
    const newCards: GeneratedCard[] = [];
    const seen = new Set<string>(priorContext.map(cardKey).filter(Boolean));
    const dedupHandlers: GenerateHandlers = {
      onCard: (card) => {
        const key = cardKey(card);
        if (!key || seen.has(key)) return;
        seen.add(key);
        newCards.push(card);
        priorContext.push(card);
        handlers.onCard(card);
      },
      onPartial: handlers.onPartial,
      onStage: handlers.onStage,
      onReasoning: handlers.onReasoning,
    };

    let debug: GenerateResult["debug"];
    let truncated = false;
    let covered = false;
    for (let batch = 0; batch < maxBatches; batch++) {
      if (signal?.aborted) break;
      const countBefore = newCards.length;
      try {
        const result = await this.generateStream(
          config,
          { ...base, generatedSoFar: priorContext.length ? priorContext.slice(-PRIOR_CARD_LIMIT) : undefined },
          dedupHandlers,
          signal,
        );
        debug = result.debug ?? debug;
        truncated = result.truncated ?? false;
        covered = result.covered ?? false;
      } catch (e) {
        if (signal?.aborted) break;
        // The first round's failure is the real error; a later one keeps what arrived.
        if (batch === 0) throw e;
        break;
      }
      if (covered) break;
      if (newCards.length === countBefore && !truncated) break;
    }
    return { cards: newCards, debug, truncated, covered };
  }

  /**
   * Generate a large source a chunk at a time, so the first cards come from the
   * first chunk rather than after the whole source. The next chunk is read while
   * the current one generates; cards are deduplicated across chunks.
   */
  async generateChunked(
    config: AiProviderConfig,
    req: GenerateChunkedRequest,
    handlers: GenerateHandlers,
    signal?: AbortSignal,
  ): Promise<GenerateChunkedResult> {
    const { chunks, existingCards, extraContext, images, ...base } = req;
    const prior: GeneratedCard[] = [...(existingCards ?? [])];
    const seen = new Set<string>(prior.map(cardKey).filter(Boolean));
    const result: GenerateChunkedResult = { cards: [], doneChunks: 0, emptyChunks: 0 };
    let extra = extraContext?.trim() ?? "";
    let pictures = images;
    let allCovered = true;

    let next: Promise<string> | null = chunks[0]?.load() ?? null;
    for (let i = 0; i < chunks.length && next !== null; i++) {
      if (signal?.aborted) break;
      const chunk = chunks[i];
      const section = { kind: "section" as const, index: i + 1, total: chunks.length, label: chunk.label };
      handlers.onStage?.(section);
      let text: string;
      try {
        text = (await next).trim();
      } catch (e) {
        if (signal?.aborted) break;
        if (result.cards.length === 0) throw e;
        result.error = e;
        break;
      }
      next = chunks[i + 1]?.load() ?? null;
      // Awaited on the next pass; this only keeps an early failure from going unhandled.
      next?.catch(() => {});
      if (!text) {
        result.emptyChunks += 1;
        continue;
      }

      // The chunk's own pages last, so the cap keeps them over cards from elsewhere.
      const pages = new Set(chunk.pages);
      const own = (c: GeneratedCard): boolean => c.page !== undefined && pages.has(c.page);
      const covered = [...prior.filter((c) => !own(c)), ...prior.filter(own)].slice(-PRIOR_CARD_LIMIT);
      try {
        const round = await this.generateStream(
          config,
          {
            ...base,
            sourceContext: [extra, text].filter(Boolean).join("\n\n"),
            images: pictures,
            generatedSoFar: covered.length ? covered : undefined,
          },
          {
            onCard: (card) => {
              const key = cardKey(card);
              if (!key || seen.has(key)) return;
              seen.add(key);
              prior.push(card);
              result.cards.push(card);
              handlers.onCard(card);
            },
            onPartial: handlers.onPartial,
            onStage: (inner) => handlers.onStage?.({ ...section, inner }),
            onReasoning: handlers.onReasoning,
          },
          signal,
        );
        extra = "";
        pictures = undefined;
        result.doneChunks += 1;
        result.debug = round.debug ?? result.debug;
        if (round.truncated) result.truncated = true;
        if (!round.covered) allCovered = false;
      } catch (e) {
        if (signal?.aborted) break;
        if (result.cards.length === 0) throw e;
        result.error = e;
        break;
      }
    }
    const finished = result.doneChunks + result.emptyChunks === chunks.length;
    // Stopped early by a failure, the rest of the source is still to read.
    if (!finished && result.error !== undefined) result.truncated = true;
    result.covered = finished && result.doneChunks > 0 && allCovered;
    return result;
  }
}
