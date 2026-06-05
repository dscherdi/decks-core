import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type { AiProvider, ProviderCompleteRequest } from "./AiProvider";
import { parseJsonBody, sendJson, streamSse } from "./http-util";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: unknown;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
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

  protected buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
    const firstUserContent = req.images?.length
      ? [
          { type: "text", text: req.user },
          ...req.images.map((im) => ({
            type: "image_url",
            image_url: { url: `data:${im.mimeType};base64,${im.dataBase64}` },
          })),
        ]
      : req.user;
    // Emit messages separately (no coalescing): keeping the source-notes user
    // message on its own preserves a byte-identical system+user cache prefix.
    const messages: ChatMessage[] = [
      { role: "system", content: req.system },
      { role: "user", content: firstUserContent },
    ];
    if (req.priorAssistant) {
      messages.push({ role: "assistant", content: req.priorAssistant });
    }
    if (req.followupUser) {
      messages.push({ role: "user", content: req.followupUser });
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
    };
    if (this.useJsonResponseFormat() && req.json !== false) {
      body["response_format"] = { type: "json_object" };
    }
    return body;
  }

  async complete(req: ProviderCompleteRequest): Promise<string> {
    const res = await sendJson(this.http, {
      url: this.endpoint(),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    });

    const parsed = parseJsonBody(res.text) as ChatCompletionResponse;
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AiError("invalid_output", "Response had no message content");
    }
    return content;
  }

  async completeStream(
    req: ProviderCompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<void> {
    const body = { ...this.buildBody(req), stream: true };
    await streamSse(
      this.http,
      {
        url: this.endpoint(),
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      },
      (data) => {
        if (data === "[DONE]") return;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          return;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) onDelta(delta);
      },
    );
  }
}
