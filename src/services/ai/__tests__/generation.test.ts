import type { HttpClient, HttpRequest } from "../HttpClient";
import { AiGenerationService } from "../AiGenerationService";
import { createProvider } from "../providers";
import {
  buildGenerationMessages,
  GenerationStreamParser,
  parseGeneratedCards,
  CARD_DELIMITER,
} from "../generation-prompt";
import type { GeneratedCard } from "../generation-prompt";
import type { AiProviderConfig } from "../types";

const card = (front: string, back: string, notes = ""): GeneratedCard => ({
  front,
  back,
  notes,
});

const block = (front: string, back: string, notes?: string): string =>
  `FRONT: ${front}\nBACK: ${back}\n${notes !== undefined ? `NOTES: ${notes}\n` : ""}${CARD_DELIMITER}\n`;

describe("parseGeneratedCards", () => {
  it("parses multiple cards with and without notes", () => {
    const text = block("Q1", "A1", "n1") + block("Q2", "A2");
    expect(parseGeneratedCards(text)).toEqual([
      card("Q1", "A1", "n1"),
      card("Q2", "A2"),
    ]);
  });

  it("treats an empty NOTES label as empty notes", () => {
    expect(parseGeneratedCards(block("Q", "A", ""))).toEqual([card("Q", "A")]);
  });

  it("supports multi-line field values", () => {
    const text = `FRONT: line1\nline2\nBACK: ans\nmore\n${CARD_DELIMITER}\n`;
    expect(parseGeneratedCards(text)).toEqual([
      card("line1\nline2", "ans\nmore"),
    ]);
  });

  it("ignores trailing prose / a card with no front", () => {
    const text = block("Q1", "A1") + "Here are your cards!\n";
    expect(parseGeneratedCards(text)).toEqual([card("Q1", "A1")]);
  });
});

describe("GenerationStreamParser", () => {
  it("emits completed cards as ===END=== boundaries arrive", () => {
    const p = new GenerationStreamParser();
    const r1 = p.push("FRONT: Q1\nBACK: A1\n");
    expect(r1.completed).toEqual([]);
    expect(r1.partial).toEqual(card("Q1", "A1"));
    const r2 = p.push(`NOTES: n1\n${CARD_DELIMITER}\nFRONT: Q2\n`);
    expect(r2.completed).toEqual([card("Q1", "A1", "n1")]);
    expect(r2.partial).toEqual(card("Q2", ""));
  });

  it("handles a delimiter split across two deltas", () => {
    const p = new GenerationStreamParser();
    p.push("FRONT: Q\nBACK: A\n===EN");
    const r = p.push("D===\n");
    expect(r.completed).toEqual([card("Q", "A")]);
    expect(r.partial).toBeNull();
  });

  it("flushes a trailing unterminated card on finish", () => {
    const p = new GenerationStreamParser();
    p.push("FRONT: Q\nBACK: A");
    expect(p.finish()).toEqual(card("Q", "A"));
  });

  it("exposes a front-only partial while the back streams", () => {
    const p = new GenerationStreamParser();
    const r = p.push("FRONT: Capital of Fra");
    expect(r.partial).toEqual(card("Capital of Fra", ""));
  });
});

describe("buildGenerationMessages", () => {
  it("includes the delimiter contract and appends source context", () => {
    const { system, user } = buildGenerationMessages({
      prompt: "Make cards about France",
      sourceContext: "Paris is the capital.",
    });
    expect(system).toContain(CARD_DELIMITER);
    expect(system).toContain("FRONT:");
    expect(user).toContain("Make cards about France");
    expect(user).toContain("Paris is the capital.");
  });
});

// A mock transport that streams the given SSE text in arbitrary chunks.
class StreamHttp implements HttpClient {
  public requests: HttpRequest[] = [];
  constructor(private readonly chunks: string[]) {}
  async request(req: HttpRequest): Promise<never> {
    this.requests.push(req);
    throw new Error("request() should not be called in streaming test");
  }
  async stream(req: HttpRequest, onChunk: (t: string) => void): Promise<void> {
    this.requests.push(req);
    for (const c of this.chunks) onChunk(c);
  }
}

const config: AiProviderConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-test",
};

describe("provider completeStream (SSE parsing)", () => {
  it("OpenAI: extracts choices[].delta.content across chunks", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"FRONT: Q"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"\\nBACK: A"}}]}\n\n' +
      "data: [DONE]\n\n";
    // Split the SSE mid-line to exercise buffering.
    const http = new StreamHttp([sse.slice(0, 25), sse.slice(25)]);
    const provider = createProvider(config, http);
    let out = "";
    await provider.completeStream!(
      { system: "s", user: "u", json: false },
      (d) => {
        out += d;
      },
    );
    expect(out).toBe("FRONT: Q\nBACK: A");
    const body = JSON.parse(http.requests[0].body ?? "{}");
    expect(body.stream).toBe(true);
    expect(body.response_format).toBeUndefined();
  });

  it("Gemini: uses streamGenerateContent?alt=sse and parses candidates", async () => {
    const sse =
      'data: {"candidates":[{"content":{"parts":[{"text":"FRONT: Q\\n"}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"BACK: A"}]}}]}\n\n';
    const http = new StreamHttp([sse]);
    const provider = createProvider(
      { provider: "gemini", model: "gemini-2.0-flash", apiKey: "k" },
      http,
    );
    let out = "";
    await provider.completeStream!(
      { system: "s", user: "u", json: false },
      (d) => {
        out += d;
      },
    );
    expect(out).toBe("FRONT: Q\nBACK: A");
    expect(http.requests[0].url).toContain(":streamGenerateContent");
    expect(http.requests[0].url).toContain("alt=sse");
  });

  it("Claude: parses content_block_delta text_delta events", async () => {
    const sse =
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"FRONT: Q"}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\nBACK: A"}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const http = new StreamHttp([sse]);
    const provider = createProvider(
      { provider: "claude", model: "claude-3-5-haiku-latest", apiKey: "k" },
      http,
    );
    let out = "";
    await provider.completeStream!(
      { system: "s", user: "u", json: false },
      (d) => {
        out += d;
      },
    );
    expect(out).toBe("FRONT: Q\nBACK: A");
  });
});

describe("AiGenerationService", () => {
  it("streams cards and reports completed + partial via handlers", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"FRONT: Q1\\nBACK: A1\\n===END===\\n"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"FRONT: Q2\\nBACK: A2\\n===END===\\n"}}]}\n\n' +
      "data: [DONE]\n\n";
    const http = new StreamHttp([sse]);
    const service = new AiGenerationService(http);
    const emitted: GeneratedCard[] = [];
    const result = await service.generateStream(
      config,
      { prompt: "go" },
      { onCard: (c) => emitted.push(c) },
    );
    expect(result.cards).toEqual([card("Q1", "A1"), card("Q2", "A2")]);
    expect(emitted).toEqual(result.cards);
  });

  it("falls back to non-streaming complete() when streaming fails before any card", async () => {
    const raw = block("Q", "A", "n");
    const http: HttpClient = {
      async request() {
        return { status: 200, text: raw };
      },
      async stream() {
        throw new Error("CORS blocked");
      },
    };
    // Force OpenAI to parse the full body as a single message content.
    const completeHttp: HttpClient = {
      async request() {
        return {
          status: 200,
          text: JSON.stringify({
            choices: [{ message: { content: raw } }],
          }),
        };
      },
      async stream() {
        throw new Error("CORS blocked");
      },
    };
    const service = new AiGenerationService(completeHttp);
    const result = await service.generateStream(config, { prompt: "go" }, {
      onCard: () => {},
    });
    expect(result.cards).toEqual([card("Q", "A", "n")]);
    void http;
  });

  it("throws missing_key for hosted providers without a key", async () => {
    const service = new AiGenerationService(new StreamHttp([]));
    await expect(
      service.generateStream(
        { provider: "openai", model: "gpt-4o-mini" },
        { prompt: "go" },
        { onCard: () => {} },
      ),
    ).rejects.toMatchObject({ code: "missing_key" });
  });
});
