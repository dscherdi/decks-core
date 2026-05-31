import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type { AiProvider } from "./AiProvider";
import { parseJsonBody, sendJson } from "./http-util";

interface ClaudeResponse {
  content?: Array<{ type?: string; text?: unknown }>;
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;

export class ClaudeProvider implements AiProvider {
  readonly id: AiProviderId = "claude";

  constructor(
    private readonly config: AiProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async complete(
    system: string,
    user: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const body = {
      model: this.config.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    };

    const res = await sendJson(this.http, {
      url: ENDPOINT,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });

    const parsed = parseJsonBody(res.text) as ClaudeResponse;
    const block = parsed.content?.find((c) => c.type === "text");
    const text = block?.text;
    if (typeof text !== "string") {
      throw new AiError("invalid_output", "Claude response had no text content");
    }
    return text;
  }
}
