import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type { AiProvider, ProviderCompleteRequest } from "./AiProvider";
import { parseJsonBody, sendJson, streamSse } from "./http-util";

interface ClaudeResponse {
  content?: Array<{ type?: string; text?: unknown }>;
}

interface ClaudeStreamEvent {
  type?: string;
  delta?: { type?: string; text?: unknown };
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;

export class ClaudeProvider implements AiProvider {
  readonly id: AiProviderId = "claude";

  constructor(
    private readonly config: AiProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  private buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
    const userContent = req.images?.length
      ? [
          { type: "text", text: req.user },
          ...req.images.map((im) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: im.mimeType,
              data: im.dataBase64,
            },
          })),
        ]
      : req.user;
    return {
      model: this.config.model,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: "user", content: userContent }],
    };
  }

  async complete(req: ProviderCompleteRequest): Promise<string> {
    const res = await sendJson(this.http, {
      url: ENDPOINT,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    });

    const parsed = parseJsonBody(res.text) as ClaudeResponse;
    const block = parsed.content?.find((c) => c.type === "text");
    const text = block?.text;
    if (typeof text !== "string") {
      throw new AiError("invalid_output", "Claude response had no text content");
    }
    return text;
  }

  async completeStream(
    req: ProviderCompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<void> {
    const body = { ...this.buildBody(req), stream: true };
    await streamSse(
      this.http,
      {
        url: ENDPOINT,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      },
      (data) => {
        let event: ClaudeStreamEvent;
        try {
          event = JSON.parse(data) as ClaudeStreamEvent;
        } catch {
          return;
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          onDelta(event.delta.text);
        }
      },
    );
  }
}
