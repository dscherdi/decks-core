import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import {
  buildChatMessages,
  parseChatAnswer,
  recentTurns,
  type ChatAnswer,
  type ChatRequest,
  deckForChat,
} from "./chat";
import type { AiProviderConfig } from "./types";
import { AiError } from "./types";

export interface ChatResult {
  answer: ChatAnswer;
  debug?: { provider: string; model: string; system: string; user: string; raw: string };
}

/** One question against the attached source. The answer is grounded in what the
 *  caller sends — the source, the cards already made and the known gaps. */
export class AiChatService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  async ask(
    config: AiProviderConfig,
    req: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (!req.question.trim()) {
      return { answer: { text: "", pages: [], gaps: [] } };
    }
    if (config.provider !== "openai-compatible" && !config.apiKey) {
      throw new AiError("missing_key", "No API key configured for this provider");
    }

    const provider = createProvider(config, this.http);
    const serverSide = provider.buildsPromptServerSide?.() === true;
    const { system, user } = serverSide
      ? { system: "", user: "" }
      : buildChatMessages(req);

    this.logger?.debug("AI chat question");

    const raw = await provider.complete({
      system,
      user,
      rawChat: serverSide
        ? {
            question: req.question,
            source: req.source,
            staged: [...(req.staged ?? [])],
            uncovered: [...(req.uncovered ?? [])],
            deck: deckForChat(req.deck ?? []),
            history: recentTurns(req.history ?? []),
          }
        : undefined,
      json: false,
      signal,
    });

    return {
      answer: parseChatAnswer(raw),
      debug: req.debug
        ? { provider: config.provider, model: config.model, system, user, raw }
        : undefined,
    };
  }
}
