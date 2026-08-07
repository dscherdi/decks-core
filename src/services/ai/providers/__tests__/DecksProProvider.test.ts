import type { HttpClient, HttpRequest } from "../../HttpClient";
import { createProvider } from "../index";
import { ocrSentinelForTier, DECKS_TIER_FAST, DECKS_TIER_QUALITY } from "../../models";
import type { AiProviderConfig } from "../../types";

/**
 * The wire shape the Decks Pro backend receives.
 *
 * An OCR request is recognised by a prefix test on the model sentinel. If that
 * test and the sentinel ever drift apart, the request falls through to the
 * generic chat body, arrives with no `images` field, and the server transcribes
 * an empty page — the model answers "I'm unable to access the page image"
 * and that refusal gets cached as if it were the page's text. So these tests
 * drive the prefix from the real constant rather than a literal.
 */

interface Sent {
  model?: string;
  images?: Array<{ mimeType: string; dataBase64: string }>;
  messages?: unknown;
  source?: string;
}

function capture(): { http: HttpClient; last: () => Sent } {
  let body: Sent = {};
  const http: HttpClient = {
    request: async (req: HttpRequest) => {
      body = JSON.parse(String(req.body ?? "{}")) as Sent;
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({ choices: [{ message: { content: "page text" } }] }),
      };
    },
  };
  return { http, last: () => body };
}

function providerFor(model: string, http: HttpClient) {
  const config: AiProviderConfig = {
    provider: "decks-pro",
    apiKey: "dk_test",
    model,
    baseUrl: "https://example.invalid",
  };
  return createProvider(config, http);
}

const image = { mimeType: "image/jpeg", dataBase64: "QUJDREVG" };

describe("DecksProProvider OCR payload", () => {
  // The tier is derived from the generation choice, so every tier must produce
  // the same OCR shape.
  it.each([DECKS_TIER_FAST, DECKS_TIER_QUALITY])(
    "sends images for the sentinel derived from %s",
    async (tier) => {
      const { http, last } = capture();
      const sentinel = ocrSentinelForTier(tier);
      await providerFor(sentinel, http).complete({
        system: "",
        user: "",
        images: [image],
        json: false,
      });

      const sent = last();
      expect(sent.model).toBe(sentinel);
      expect(sent.images).toEqual([image]);
      // The server builds the OCR messages; sending our own would be ignored.
      expect(sent.messages).toBeUndefined();
    },
  );

  // Older plugin builds still send the tiered sentinels, and the backend still
  // accepts them. The client must keep producing the images-only shape for them.
  it.each(["decks-ocr", "decks-ocr-fast", "decks-ocr-quality"])(
    "recognises the legacy sentinel %s",
    async (sentinel) => {
      const { http, last } = capture();
      await providerFor(sentinel, http).complete({
        system: "",
        user: "",
        images: [image],
        json: false,
      });
      expect(last().images).toEqual([image]);
    },
  );

  // The guard against the opposite failure: a generation request must NOT be
  // mistaken for OCR, or the source text would be dropped.
  it("keeps the raw generation shape for a generation sentinel", async () => {
    const { http, last } = capture();
    await providerFor(DECKS_TIER_FAST, http).complete({
      system: "",
      user: "",
      rawSource: "some source",
      rawPrompt: "make cards",
      json: false,
    });

    const sent = last();
    expect(sent.source).toBe("some source");
    expect(sent.images).toBeUndefined();
  });
});
