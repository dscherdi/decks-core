import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import { buildMessages, diffFields, parseProposed } from "./refactor-prompt";
import type { AiProviderConfig, RefactorRequest, RefactorResult } from "./types";
import { AiError } from "./types";

/**
 * Provider-agnostic orchestrator for AI flashcard refactoring. Stateless: it
 * builds the prompt, calls the configured provider, and returns per-field
 * proposals. Applying accepted changes is the caller's responsibility.
 */
export class AiRefactoringService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  async refactorCard(
    config: AiProviderConfig,
    req: RefactorRequest,
    signal?: AbortSignal,
  ): Promise<RefactorResult> {
    if (config.provider !== "openai-compatible" && !config.apiKey) {
      throw new AiError(
        "missing_key",
        "No API key configured for this provider",
      );
    }

    const provider = createProvider(config, this.http);
    const { system, user } = buildMessages(req);

    // Log endpoint/provider only — never headers, body, or keys.
    this.logger?.debug(`AI refactor via ${config.provider} (${config.model})`);

    const raw = await provider.complete(system, user, signal);
    const proposed = parseProposed(raw, req.current);
    const proposals = diffFields(req.current, proposed);
    return { proposed, proposals };
  }
}
