import type { HttpClient, HttpRequest, HttpResponse } from "../HttpClient";
import { AiRefactoringService } from "../AiRefactoringService";
import { createProvider } from "../providers";
import { parseProposed, diffFields } from "../refactor-prompt";
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
    const out = await provider.complete("system", "user");

    expect(out).toBe('{"back":"Paris"}');
    const req = http.requests[0];
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(req.body ?? "{}");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
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
    const out = await provider.complete("system", "user");
    expect(out).toBe('{"back":"Paris"}');
    expect(http.requests[0].url).toContain(
      "/v1beta/models/gemini-2.0-flash:generateContent?key=g-key",
    );
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
    const out = await provider.complete("system", "user");
    expect(out).toBe('{"back":"Paris"}');
    const req = http.requests[0];
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("a-key");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
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
    await provider.complete("system", "user");
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
    await expect(provider.complete("s", "u")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps 500 to provider_error", async () => {
    const http = new MockHttp(() => ({ status: 500, text: "boom" }));
    const provider = createProvider(
      { provider: "openai", model: "m", apiKey: "k" },
      http,
    );
    await expect(provider.complete("s", "u")).rejects.toMatchObject({
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
    await expect(provider.complete("s", "u")).rejects.toMatchObject({
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
    await expect(provider.complete("s", "u", ac.signal)).rejects.toMatchObject({
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
  });
});
