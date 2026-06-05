import type { HttpClient } from "../HttpClient";
import type { AiProviderConfig } from "../types";
import type { AiProvider } from "./AiProvider";
import { ClaudeProvider } from "./ClaudeProvider";
import { DecksCloudProvider } from "./DecksCloudProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiCompatibleProvider } from "./OpenAiCompatibleProvider";
import { OpenAiProvider } from "./OpenAiProvider";

export function createProvider(
  config: AiProviderConfig,
  http: HttpClient,
): AiProvider {
  switch (config.provider) {
    case "gemini":
      return new GeminiProvider(config, http);
    case "openai":
      return new OpenAiProvider(config, http);
    case "claude":
      return new ClaudeProvider(config, http);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(config, http);
    case "decks-cloud":
      return new DecksCloudProvider(config, http);
  }
}

export type { AiProvider };
