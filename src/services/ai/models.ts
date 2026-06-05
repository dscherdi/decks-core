import type { AiProviderId } from "./types";

export interface AiModelOption {
  id: string;
  name: string;
}

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
};
