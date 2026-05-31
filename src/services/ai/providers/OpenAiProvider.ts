import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type { AiProvider } from "./AiProvider";
import { parseJsonBody, sendJson } from "./http-util";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * OpenAI Chat Completions, also reused by the openai-compatible provider
 * (Ollama, LM Studio, vLLM, …) which speaks the same wire format.
 */
export class OpenAiProvider implements AiProvider {
  readonly id: AiProviderId;

  constructor(
    protected readonly config: AiProviderConfig,
    protected readonly http: HttpClient,
  ) {
    this.id = config.provider;
  }

  protected endpoint(): string {
    return "https://api.openai.com/v1/chat/completions";
  }

  /** Whether to request strict JSON output (hosted OpenAI supports it). */
  protected useJsonResponseFormat(): boolean {
    return true;
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  async complete(
    system: string,
    user: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (this.useJsonResponseFormat()) {
      body["response_format"] = { type: "json_object" };
    }

    const res = await sendJson(this.http, {
      url: this.endpoint(),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    const parsed = parseJsonBody(res.text) as ChatCompletionResponse;
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AiError("invalid_output", "Response had no message content");
    }
    return content;
  }
}
