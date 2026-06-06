import type { AiProviderId } from "./types";

export interface AiModelOption {
  id: string;
  name: string;
}

// Default origin of the hosted Decks Cloud proxy; an empty baseUrl in settings
// falls back to this.
export const DECKS_CLOUD_DEFAULT_BASE_URL =
  "https://decks-backend.dscherdil.workers.dev";

// Curated model lists offered in the settings model picker. Hosted providers
// surface these as a dropdown; the local (openai-compatible) provider uses a
// free-text field since its model ids depend on the running server.
export const PROVIDER_MODELS: Record<AiProviderId, AiModelOption[]> = {
  openai: [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.5-pro", name: "GPT-5.5 Pro" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  ],
  claude: [
    { id: "claude-opus-4-8", name: "Claude 4.8 Opus" },
    { id: "claude-sonnet-4-6", name: "Claude 4.6 Sonnet" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
  ],
  gemini: [
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite" },
  ],
  "openai-compatible": [],
  "decks-cloud": [
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1" },
    { id: "qwen/qwen-3.7-plus", name: "Qwen 3.7 Plus" },
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B" },
    { id: "google/gemma-4-31b-it", name: "Gemma 4 31B" },
  ],
};
