import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type { AiProvider, ProviderCompleteRequest } from "./AiProvider";
import { parseJsonBody, sendJson, streamSse } from "./http-util";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
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
    const parts = [
      { text: req.user },
      ...(req.images ?? []).map((im) => ({
        inlineData: { mimeType: im.mimeType, data: im.dataBase64 },
      })),
    ];
    return {
      system_instruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts }],
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
  ): Promise<void> {
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
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text === "string" && text) onDelta(text);
      },
    );
  }
}
