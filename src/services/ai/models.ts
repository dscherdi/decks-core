import type { AiProviderId } from "./types";

export interface AiModelOption {
  id: string;
  name: string;
}

// Default origin of the hosted Decks Pro proxy; an empty baseUrl in settings
// falls back to this.
export const DECKS_PRO_DEFAULT_BASE_URL =
  "https://decks-backend.dscherdil.workers.dev";

// Public website: sign-in, subscription management, and the client link flow.
export const DECKS_PRO_SITE_URL = "https://decksmd.app";

/** Decks Pro generation tier sentinels (resolved by the backend). */
export const DECKS_TIER_FAST = "decks-tier-fast";
export const DECKS_TIER_QUALITY = "decks-tier-quality";

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
  // Decks Pro exposes generation *tiers*, not raw models. The client stores/sends
  // a tier sentinel that the backend resolves.
  "decks-pro": [
    { id: DECKS_TIER_FAST, name: "Fast & general" },
    { id: DECKS_TIER_QUALITY, name: "High quality & thinking" },
  ],
};

/**
 * OCR sentinel for a Decks Pro tier. Sent by the client for PDF page OCR; the
 * backend resolves it.
 */
export function ocrSentinelForTier(tier: string): string {
  return tier === DECKS_TIER_QUALITY ? "decks-ocr-quality" : "decks-ocr-fast";
}
