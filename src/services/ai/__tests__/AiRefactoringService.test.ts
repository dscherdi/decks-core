import type { HttpClient, HttpRequest, HttpResponse } from "../HttpClient";
import { AiRefactoringService } from "../AiRefactoringService";
import { createProvider } from "../providers";
import { parseProposed, diffFields, buildMessages } from "../refactor-prompt";
import { AiError } from "../types";
import type { AiProviderConfig, RefactorFieldSet } from "../types";

class MockHttp implements HttpClient {
  public requests: HttpRequest[] = [];
  constructor(
    private readonly responder: (
      req: HttpRequest,
    ) => HttpResponse | Promise<HttpResponse>,
  ) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.responder(req);
  }
}

const ok = (text: string): HttpResponse => ({ status: 200, text });

const headerParaCard: RefactorFieldSet = {
  type: "header-paragraph",
  front: "What is the capital of France?",
  back: "paris",
};

describe("OpenAiProvider", () => {
  it("builds the chat-completions request and parses content", async () => {
    const http = new MockHttp(() =>
      ok(
        JSON.stringify({
          choices: [{ message: { content: '{"back":"Paris"}' } }],
        }),
      ),
    );
    const config: AiProviderConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    };
    const provider = createProvider(config, http);
    const out = await provider.complete({ system: "system", user: "user" });

    expect(out).toBe('{"back":"Paris"}');
    const req = http.requests[0];
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(req.body ?? "{}");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
    // No images → user content stays a plain string.
    expect(body.messages[1].content).toBe("user");
  });

  it("sends image parts as image_url when images are attached", async () => {
    const http = new MockHttp(() =>
      ok(JSON.stringify({ choices: [{ message: { content: "{}" } }] })),
    );
    const provider = createProvider(
      { provider: "openai", model: "gpt-4o", apiKey: "sk" },
      http,
    );
    await provider.complete({
      system: "s",
      user: "u",
      images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
    });
    const body = JSON.parse(http.requests[0].body ?? "{}");
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "u" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" },
      },
    ]);
  });
});

describe("GeminiProvider", () => {
  it("puts the key in the URL and parses candidates", async () => {
    const http = new MockHttp(() =>
      ok(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"back":"Paris"}' }] } }],
        }),
      ),
    );
    const provider = createProvider(
      { provider: "gemini", model: "gemini-2.0-flash", apiKey: "g-key" },
      http,
    );
    const out = await provider.complete({ system: "system", user: "user" });
    expect(out).toBe('{"back":"Paris"}');
    expect(http.requests[0].url).toContain(
      "/v1beta/models/gemini-2.0-flash:generateContent?key=g-key",
    );
  });

  it("appends inlineData parts for attached images", async () => {
    const http = new MockHttp(() =>
      ok(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
        }),
      ),
    );
    const provider = createProvider(
      { provider: "gemini", model: "gemini-2.0-flash", apiKey: "g" },
      http,
    );
    await provider.complete({
      system: "s",
      user: "u",
      images: [{ mimeType: "image/jpeg", dataBase64: "ZZZ" }],
    });
    const body = JSON.parse(http.requests[0].body ?? "{}");
    expect(body.contents[0].parts).toEqual([
      { text: "u" },
      { inlineData: { mimeType: "image/jpeg", data: "ZZZ" } },
    ]);
  });
});

describe("ClaudeProvider", () => {
  it("sets anthropic headers and parses content blocks", async () => {
    const http = new MockHttp(() =>
      ok(
        JSON.stringify({
          content: [{ type: "text", text: '{"back":"Paris"}' }],
        }),
      ),
    );
    const provider = createProvider(
      { provider: "claude", model: "claude-3-5-haiku-latest", apiKey: "a-key" },
      http,
    );
    const out = await provider.complete({ system: "system", user: "user" });
    expect(out).toBe('{"back":"Paris"}');
    const req = http.requests[0];
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("a-key");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("sends base64 image source blocks for attached images", async () => {
    const http = new MockHttp(() =>
      ok(JSON.stringify({ content: [{ type: "text", text: "{}" }] })),
    );
    const provider = createProvider(
      { provider: "claude", model: "claude-3-5-haiku-latest", apiKey: "a" },
      http,
    );
    await provider.complete({
      system: "s",
      user: "u",
      images: [{ mimeType: "image/webp", dataBase64: "WWW" }],
    });
    const body = JSON.parse(http.requests[0].body ?? "{}");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "u" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/webp", data: "WWW" },
      },
    ]);
  });
});

describe("OpenAiCompatibleProvider", () => {
  it("uses the base URL and omits response_format", async () => {
    const http = new MockHttp(() =>
      ok(
        JSON.stringify({
          choices: [{ message: { content: '{"back":"Paris"}' } }],
        }),
      ),
    );
    const provider = createProvider(
      {
        provider: "openai-compatible",
        model: "gemma",
        baseUrl: "http://localhost:11434/v1",
      },
      http,
    );
    await provider.complete({ system: "system", user: "user" });
    const req = http.requests[0];
    expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(req.headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(req.body ?? "{}");
    expect(body.response_format).toBeUndefined();
  });
});

describe("error handling", () => {
  const okResponder = () =>
    ok(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));

  it("throws missing_key for hosted providers without a key", async () => {
    const svc = new AiRefactoringService(new MockHttp(okResponder));
    await expect(
      svc.refactorCard(
        { provider: "openai", model: "gpt-4o-mini" },
        { prompt: "improve", current: headerParaCard },
      ),
    ).rejects.toMatchObject({ code: "missing_key" });
  });

  it("maps 429 to rate_limited", async () => {
    const http = new MockHttp(() => ({ status: 429, text: "slow down" }));
    const provider = createProvider(
      { provider: "openai", model: "m", apiKey: "k" },
      http,
    );
    await expect(
      provider.complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps 500 to provider_error", async () => {
    const http = new MockHttp(() => ({ status: 500, text: "boom" }));
    const provider = createProvider(
      { provider: "openai", model: "m", apiKey: "k" },
      http,
    );
    await expect(
      provider.complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it("maps transport failures to network_error", async () => {
    const http = new MockHttp(() => {
      throw new Error("ECONNREFUSED");
    });
    const provider = createProvider(
      { provider: "openai", model: "m", apiKey: "k" },
      http,
    );
    await expect(
      provider.complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("throws aborted when the signal is already aborted", async () => {
    const http = new MockHttp(okResponder);
    const provider = createProvider(
      { provider: "openai", model: "m", apiKey: "k" },
      http,
    );
    const ac = new AbortController();
    ac.abort();
    await expect(
      provider.complete({ system: "s", user: "u", signal: ac.signal }),
    ).rejects.toMatchObject({
      code: "aborted",
    });
  });
});

describe("parseProposed", () => {
  it("merges known string fields onto the current values", () => {
    const out = parseProposed('{"back":"Paris"}', headerParaCard);
    expect(out).toEqual({
      type: "header-paragraph",
      front: "What is the capital of France?",
      back: "Paris",
    });
  });

  it("strips markdown code fences", () => {
    const out = parseProposed(
      '```json\n{"back":"Paris"}\n```',
      headerParaCard,
    );
    expect((out as { back: string }).back).toBe("Paris");
  });

  it("ignores unknown keys but keeps known ones", () => {
    const out = parseProposed(
      '{"back":"Paris","bogus":"x"}',
      headerParaCard,
    );
    expect(out as Record<string, unknown>).not.toHaveProperty("bogus");
    expect((out as { back: string }).back).toBe("Paris");
  });

  it("throws invalid_output on malformed JSON", () => {
    expect(() => parseProposed("not json", headerParaCard)).toThrow(AiError);
  });

  it("throws invalid_output when no known field is present", () => {
    expect(() => parseProposed('{"bogus":"x"}', headerParaCard)).toThrow(
      AiError,
    );
  });

  it("only merges fields in targetKeys; ignores non-target changes", () => {
    const out = parseProposed(
      '{"front":"NEW FRONT","back":"Paris"}',
      headerParaCard,
      ["back"],
    );
    expect(out).toEqual({
      type: "header-paragraph",
      front: "What is the capital of France?", // unchanged: front not targeted
      back: "Paris",
    });
  });
});

describe("buildMessages", () => {
  it("includes custom instructions and source context", () => {
    const { system, user } = buildMessages({
      prompt: "Improve the card",
      current: headerParaCard,
      instructions: "Translate to English.",
      sourceContext: "10: surrounding note text",
    });
    expect(system).toContain("Translate to English.");
    expect(user).toContain("surrounding note text");
  });

  it("restricts rewritable fields to targetKeys and marks others context-only", () => {
    const { system } = buildMessages({
      prompt: "Improve the card",
      current: { type: "table", front: "F", back: "B", notes: "N" },
      targetKeys: ["front", "back"],
    });
    expect(system).toContain('You may rewrite ONLY these fields: "front"');
    expect(system).toContain('"notes"'); // listed as context-only
    expect(system).toMatch(/context only/i);
  });
});

describe("diffFields", () => {
  it("returns only the fields that changed", () => {
    const after: RefactorFieldSet = {
      type: "header-paragraph",
      front: "What is the capital of France?",
      back: "Paris",
    };
    const proposals = diffFields(headerParaCard, after);
    expect(proposals).toEqual([
      { key: "back", before: "paris", after: "Paris" },
    ]);
  });
});

describe("AiRefactoringService.refactorCard", () => {
  it("returns proposed fields and a per-field diff", async () => {
    const http = new MockHttp(() =>
      ok(
        JSON.stringify({
          choices: [{ message: { content: '{"back":"Paris"}' } }],
        }),
      ),
    );
    const svc = new AiRefactoringService(http);
    const result = await svc.refactorCard(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "sk" },
      { prompt: "Capitalize properly", current: headerParaCard },
    );
    expect((result.proposed as { back: string }).back).toBe("Paris");
    expect(result.proposals).toEqual([
      { key: "back", before: "paris", after: "Paris" },
    ]);
    expect(result.debug).toBeUndefined();
  });

  it("attaches the exchange to the result when debug is set", async () => {
    const http = new MockHttp(() =>
      ok(
        JSON.stringify({
          choices: [{ message: { content: '{"back":"Paris"}' } }],
        }),
      ),
    );
    const svc = new AiRefactoringService(http);
    const result = await svc.refactorCard(
      { provider: "openai", model: "gpt-4o-mini", apiKey: "sk" },
      { prompt: "Capitalize properly", current: headerParaCard, debug: true },
    );
    expect(result.debug?.system).toContain("Capitalize properly");
    expect(result.debug?.user).toContain("paris");
    expect(result.debug?.raw).toContain("Paris");
  });

  it("attaches the exchange to a parse-error AiError when debug is set", async () => {
    const http = new MockHttp(() =>
      ok(JSON.stringify({ choices: [{ message: { content: "not json" } }] })),
    );
    const svc = new AiRefactoringService(http);
    await expect(
      svc.refactorCard(
        { provider: "openai", model: "gpt-4o-mini", apiKey: "sk" },
        { prompt: "p", current: headerParaCard, debug: true },
      ),
    ).rejects.toMatchObject({ code: "invalid_output", debug: { raw: "not json" } });
  });
});
