import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type { AiProvider, ProviderCompleteRequest, StreamResult } from "./AiProvider";
import { parseJsonBody, sendJson, streamSse } from "./http-util";
import { buildTurns, coalesceAdjacentRoles } from "./turns";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
    finishReason?: string;
  }>;
}

const BASE = "https://generativelanguage.googleapis.com";

export class GeminiProvider implements AiProvider {
  readonly id: AiProviderId = "gemini";

  constructor(
    private readonly config: AiProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private url(method: "generateContent" | "streamGenerateContent"): string {
    const base = `${BASE}/v1beta/models/${encodeURIComponent(
      this.config.model,
    )}:${method}?key=${encodeURIComponent(this.config.apiKey ?? "")}`;
    return method === "streamGenerateContent" ? `${base}&alt=sse` : base;
  }

  private buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
    // Gemini wants alternating roles (user/model), so coalesce same-role turns.
    // Images attach to the first user turn (turns always start with a user turn).
    const turns = coalesceAdjacentRoles(buildTurns(req));
    const contents = turns.map((turn, i) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts:
        i === 0 && req.images?.length
          ? [
              { text: turn.text },
              ...req.images.map((im) => ({
                inlineData: { mimeType: im.mimeType, data: im.dataBase64 },
              })),
            ]
          : [{ text: turn.text }],
    }));
    return {
      system_instruction: { parts: [{ text: req.system }] },
      contents,
      generationConfig: {
        responseMimeType: req.json === false ? "text/plain" : "application/json",
      },
    };
  }

  async complete(req: ProviderCompleteRequest): Promise<string> {
    const res = await sendJson(this.http, {
      url: this.url("generateContent"),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    });

    const parsed = parseJsonBody(res.text) as GeminiResponse;
    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new AiError("invalid_output", "Gemini response had no text content");
    }
    return text;
  }

  async completeStream(
    req: ProviderCompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<StreamResult> {
    let finishReason: string | undefined;
    await streamSse(
      this.http,
      {
        url: this.url("streamGenerateContent"),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.buildBody(req)),
        signal: req.signal,
      },
      (data) => {
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(data) as GeminiResponse;
        } catch {
          return;
        }
        const candidate = chunk.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;
        if (typeof text === "string" && text) onDelta(text);
        // Normalize Gemini's "MAX_TOKENS" to "length".
        if (candidate?.finishReason) {
          finishReason =
            candidate.finishReason === "MAX_TOKENS"
              ? "length"
              : candidate.finishReason;
        }
      },
    );
    return { finishReason };
  }
}
