import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig, AiProviderId } from "../types";
import { AiError } from "../types";
import type { AiProvider, ProviderCompleteRequest } from "./AiProvider";
import { parseJsonBody, sendJson } from "./http-util";

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

  async complete({
    system,
    user,
    images,
    signal,
  }: ProviderCompleteRequest): Promise<string> {
    const url = `${BASE}/v1beta/models/${encodeURIComponent(
      this.config.model,
    )}:generateContent?key=${encodeURIComponent(this.config.apiKey ?? "")}`;

    const parts = [
      { text: user },
      ...(images ?? []).map((im) => ({
        inlineData: { mimeType: im.mimeType, data: im.dataBase64 },
      })),
    ];
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" },
    };

    const res = await sendJson(this.http, {
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    const parsed = parseJsonBody(res.text) as GeminiResponse;
    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new AiError("invalid_output", "Gemini response had no text content");
    }
    return text;
  }
}
