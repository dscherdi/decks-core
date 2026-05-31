import { AiError } from "../types";
import { OpenAiProvider } from "./OpenAiProvider";

/**
 * Generic OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM).
 * Uses the configured base URL; strict JSON response_format is omitted because
 * not every local server supports it — the orchestrator's tolerant parsing and
 * prompt instructions handle output shape instead.
 */
export class OpenAiCompatibleProvider extends OpenAiProvider {
  protected endpoint(): string {
    const base = this.config.baseUrl?.trim();
    if (!base) {
      throw new AiError(
        "provider_error",
        "No base URL configured for the local/OpenAI-compatible provider",
      );
    }
    const trimmed = base.replace(/\/+$/, "");
    return trimmed.endsWith("/chat/completions")
      ? trimmed
      : `${trimmed}/chat/completions`;
  }

  protected useJsonResponseFormat(): boolean {
    return false;
  }
}
