import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import {
  buildCritiqueMessages,
  parseVerdicts,
  settleVerdicts,
  type CardVerdict,
  type CritiqueRequest,
} from "./critique-prompt";
import type { AiProviderConfig } from "./types";
import { AiError } from "./types";

/** Structured request payload + raw response, attached only when `debug` was set. */
export interface CritiqueDebugInfo {
  provider: string;
  model: string;
  system: string;
  user: string;
  raw: string;
}

export interface CritiqueResult {
  verdicts: CardVerdict[];
  debug?: CritiqueDebugInfo;
}

/** The second pass over generated cards: one batched call per round,
 *  non-streaming. */
export class AiCritiqueService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  async critique(
    config: AiProviderConfig,
    req: CritiqueRequest,
    signal?: AbortSignal,
  ): Promise<CritiqueResult> {
    if (req.cards.length === 0) return { verdicts: [] };
    if (config.provider !== "openai-compatible" && !config.apiKey) {
      throw new AiError("missing_key", "No API key configured for this provider");
    }

    const provider = createProvider(config, this.http);
    const serverSide = provider.buildsPromptServerSide?.() === true;
    const { system, user } = serverSide
      ? { system: "", user: "" }
      : buildCritiqueMessages(req);

    this.logger?.debug(`AI critique of ${req.cards.length} cards`);

    const raw = await provider.complete({
      system,
      user,
      rawCritique: serverSide ? req.cards : undefined,
      rawCardType: req.cardType,
      // Labelled delimited text, as the cards use: two providers refuse a JSON
      // response format outright.
      json: false,
      signal,
    });

    const verdicts = parseVerdicts(raw);
    // Only judgements about cards we actually asked about. A model echoing an id
    // that was never sent would otherwise flag a row at random.
    const asked = new Set(req.cards.map((c) => c.id));
    const kept = settleVerdicts(
      verdicts.filter((v) => asked.has(v.id)),
      req.cards,
      req.cardType ?? "basic",
    );

    return {
      verdicts: kept,
      debug: req.debug
        ? { provider: config.provider, model: config.model, system, user, raw }
        : undefined,
    };
  }
}
