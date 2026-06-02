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

    // Debug logging (gated by the injected logger — never logs headers/keys, only
    // the message text and raw response).
    this.logger?.debug(`AI refactor via ${config.provider} (${config.model})`);
    this.logger?.debug(`AI request system:\n${system}`);
    this.logger?.debug(`AI request user:\n${user}`);
    if (req.images?.length) {
      // Never log the base64 payload — only how many images and their types.
      this.logger?.debug(
        `AI request images: ${req.images.length} (${req.images
          .map((im) => im.mimeType)
          .join(", ")})`,
      );
    }

    let raw: string;
    try {
      raw = await provider.complete({ system, user, images: req.images, signal });
    } catch (e) {
      if (req.debug && e instanceof AiError) {
        e.debug = { system, user, raw: "" };
      }
      throw e;
    }
    this.logger?.debug(`AI raw response:\n${raw}`);

    try {
      const proposed = parseProposed(raw, req.current, req.targetKeys);
      const proposals = diffFields(req.current, proposed);
      this.logger?.debug(
        `AI parsed ${proposals.length} proposal(s): ${proposals
          .map((p) => p.key)
          .join(", ")}`,
      );
      return {
        proposed,
        proposals,
        ...(req.debug ? { debug: { system, user, raw } } : {}),
      };
    } catch (e) {
      if (req.debug && e instanceof AiError) {
        e.debug = { system, user, raw };
      }
      throw e;
    }
  }
}
