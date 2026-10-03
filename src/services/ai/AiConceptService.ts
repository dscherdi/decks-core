import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import {
  buildConceptMessages,
  parseConcepts,
  type ConceptRequest,
  type SourceConcept,
} from "./concepts";
import type { AiProviderConfig } from "./types";
import { AiError } from "./types";

export interface ConceptResult {
  concepts: SourceConcept[];
  debug?: { provider: string; model: string; system: string; user: string; raw: string };
}

/**
 * One extraction pass over a source, producing the examinable-concept ledger.
 * Runs once per source and is cached by the caller, not per generation run.
 */
export class AiConceptService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  async extract(
    config: AiProviderConfig,
    req: ConceptRequest,
    signal?: AbortSignal,
  ): Promise<ConceptResult> {
    if (!req.source.trim()) return { concepts: [] };
    if (config.provider !== "openai-compatible" && !config.apiKey) {
      throw new AiError("missing_key", "No API key configured for this provider");
    }

    const provider = createProvider(config, this.http);
    const serverSide = provider.buildsPromptServerSide?.() === true;
    const { system, user } = serverSide
      ? { system: "", user: "" }
      : buildConceptMessages(req);

    this.logger?.debug("AI concept extraction");

    const raw = await provider.complete({
      system,
      user,
      rawConceptSource: serverSide ? req.source : undefined,
      json: false,
      signal,
    });

    return {
      concepts: parseConcepts(raw),
      debug: req.debug
        ? { provider: config.provider, model: config.model, system, user, raw }
        : undefined,
    };
  }
}
