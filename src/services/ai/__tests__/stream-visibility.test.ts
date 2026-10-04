import { HttpStatusError, type HttpClient, type HttpRequest } from "../HttpClient";
import { AiGenerationService } from "../AiGenerationService";
import { createProvider } from "../providers";
import { reasoningOf } from "../providers/OpenAiProvider";
import { streamSse } from "../providers/http-util";
import type { GenerationStage } from "../stages";
import { stageLabel } from "../stages";
import type { AiProviderConfig } from "../types";

// What the user sees while waiting: thinking text, server steps, silences that end
// the request, refusals that are not mistaken for a transport without streaming.

const openai: AiProviderConfig = { provider: "openai", model: "m", apiKey: "k" };
const pro: AiProviderConfig = { provider: "decks-pro", model: "decks-tier-quality", apiKey: "k" };

const sse = (...chunks: object[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const content = (text: string) => ({ choices: [{ delta: { content: text } }] });

/** A transport that plays chunks, optionally pausing between them. */
class ScriptedHttp implements HttpClient {
  requests: HttpRequest[] = [];
  streams = 0;
  completes = 0;
  constructor(
    private readonly script: Array<string | { wait: number }>,
    private readonly failWith?: unknown,
    private readonly completeText = "",
  ) {}
  async request(req: HttpRequest) {
    this.requests.push(req);
    this.completes += 1;
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: this.completeText } }] }) };
  }
  async stream(req: HttpRequest, onChunk: (text: string) => void): Promise<void> {
    this.requests.push(req);
    this.streams += 1;
    if (this.failWith) throw this.failWith;
    for (const step of this.script) {
      if (typeof step === "string") onChunk(step);
      else
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, step.wait);
          req.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
    }
  }
}

describe("thinking text", () => {
  it("reads every shape servers stream it in, skipping encrypted details", () => {
    expect(reasoningOf({ reasoning: "a" })).toBe("a");
    expect(reasoningOf({ reasoning_content: "b" })).toBe("b");
    expect(
      reasoningOf({
        reasoning_details: [
          { type: "reasoning.text", text: "c" },
          { type: "reasoning.encrypted", text: "secret" },
          { type: "reasoning.summary", summary: "d" },
        ],
      }),
    ).toBe("cd");
    expect(reasoningOf({ content: "answer" })).toBe("");
  });

  it("goes to onReasoning and never into the answer", async () => {
    const http = new ScriptedHttp([sse({ choices: [{ delta: { reasoning: "hmm " } }] }, content("FRONT: Q\nBACK: A\n===END===\n"))]);
    const thoughts: string[] = [];
    let answer = "";
    await createProvider(openai, http).completeStream!({ system: "s", user: "u" }, (d) => (answer += d), {
      onReasoning: (t) => thoughts.push(t),
    });
    expect(thoughts).toEqual(["hmm "]);
    expect(answer).not.toContain("hmm");
  });

  it("routes a backend stage chunk, and throws an error chunk", async () => {
    const stages: string[] = [];
    await createProvider(pro, new ScriptedHttp([sse({ decks: { stage: { step: "routing" } } })])).completeStream!(
      { system: "", user: "" },
      () => {},
      { onServerStage: (s) => stages.push(s.step) },
    );
    expect(stages).toEqual(["routing"]);

    const failing = new ScriptedHttp([sse({ error: { code: 502, message: "upstream gone" } })]);
    await expect(createProvider(openai, failing).completeStream!({ system: "s", user: "u" }, () => {})).rejects.toMatchObject({
      code: "provider_error",
      message: "upstream gone",
    });
  });
});

describe("silences end the request", () => {
  it("fails with a timeout when no first byte arrives", async () => {
    const http = new ScriptedHttp([{ wait: 200 }, "data: [DONE]\n\n"]);
    await expect(streamSse(http, { url: "u", method: "POST", headers: {} }, () => {}, { firstByteMs: 30 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("keeps a stream alive while bytes keep arriving, keep-alives included", async () => {
    const script: Array<string | { wait: number }> = [];
    for (let i = 0; i < 5; i++) script.push({ wait: 20 }, ": keep-alive\n\n");
    script.push("data: [DONE]\n\n");
    let activity = 0;
    await streamSse(new ScriptedHttp(script), { url: "u", method: "POST", headers: {} }, () => {}, {
      firstByteMs: 60,
      idleMs: 60,
      onActivity: () => (activity += 1),
    });
    expect(activity).toBe(6);
  });

  it("fails with a timeout when a started stream goes quiet", async () => {
    const http = new ScriptedHttp(["data: {}\n\n", { wait: 200 }]);
    await expect(
      streamSse(http, { url: "u", method: "POST", headers: {} }, () => {}, { firstByteMs: 1000, idleMs: 30 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("refusals are not mistaken for a transport without streaming", () => {
  it("maps a status on the stream to its typed error", async () => {
    const busy = new ScriptedHttp([], new HttpStatusError(429, '{"code":"rate_limited"}'));
    await expect(streamSse(busy, { url: "u", method: "POST", headers: {} }, () => {})).rejects.toMatchObject({
      code: "rate_limited",
    });
    const over = new ScriptedHttp([], new HttpStatusError(402, '{"code":"daily_quota_exceeded"}'));
    await expect(streamSse(over, { url: "u", method: "POST", headers: {} }, () => {})).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });

  it("does not run the request again after a refusal", async () => {
    const http = new ScriptedHttp([], new HttpStatusError(502, "bad gateway"), "FRONT: Q\nBACK: A\n===END===\n");
    const service = new AiGenerationService(http);
    await expect(service.generateStream(openai, { prompt: "go" }, { onCard: () => {} })).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(http.completes).toBe(0);
  });

  it("never runs the hosted request twice, even when streaming itself failed", async () => {
    const http = new ScriptedHttp([], new Error("CORS blocked"), "FRONT: Q\nBACK: A\n===END===\n");
    await expect(new AiGenerationService(http).generateStream(pro, { prompt: "go" }, { onCard: () => {} })).rejects.toMatchObject({
      code: "network_error",
    });
    expect(http.completes).toBe(0);
  });

  it("still falls back for a BYO transport that cannot stream, and says so", async () => {
    const http = new ScriptedHttp([], new Error("CORS blocked"), "FRONT: Q\nBACK: A\n===END===\n");
    const stages: GenerationStage["kind"][] = [];
    const result = await new AiGenerationService(http).generateStream(openai, { prompt: "go" }, {
      onCard: () => {},
      onStage: (s) => stages.push(s.kind),
    });
    expect(result.cards).toHaveLength(1);
    expect(http.completes).toBe(1);
    expect(stages).toContain("retrying");
  });
});

describe("stages", () => {
  it("goes sending → thinking → writing as the stream unfolds", async () => {
    const http = new ScriptedHttp([
      sse(
        { choices: [{ delta: { reasoning: "Let me see" } }] },
        content("FRONT: Q1\nBACK: A1\n===END===\n"),
        content("FRONT: Q2\nBACK: A2\n===END===\n"),
      ),
    ]);
    const stages: GenerationStage[] = [];
    const thoughts: string[] = [];
    await new AiGenerationService(http).generateStream(openai, { prompt: "go" }, {
      onCard: () => {},
      onStage: (s) => stages.push(s),
      onReasoning: (t) => thoughts.push(t),
    });
    expect(stages.map((s) => s.kind)).toEqual(["sending", "thinking", "writing", "writing", "writing"]);
    expect(stages.filter((s) => s.kind === "writing").map((s) => (s.kind === "writing" ? s.card : 0))).toEqual([1, 2, 3]);
    expect(thoughts).toEqual(["Let me see"]);
  });

  it("reports a silent model as thinking once it has kept quiet a while", async () => {
    jest.useFakeTimers();
    try {
      const http = new ScriptedHttp([{ wait: 4000 }, sse(content("FRONT: Q\nBACK: A\n===END===\n"))]);
      const stages: GenerationStage["kind"][] = [];
      const run = new AiGenerationService(http).generateStream(openai, { prompt: "go" }, {
        onCard: () => {},
        onStage: (s) => stages.push(s.kind),
      });
      await jest.advanceTimersByTimeAsync(4100);
      await run;
      expect(stages.slice(0, 3)).toEqual(["sending", "thinking", "writing"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("labels each stage, with the thinking time ticking", () => {
    expect(stageLabel({ kind: "thinking", since: 1000 }, 25_400)).toBe("Thinking · 24 s");
    expect(stageLabel({ kind: "writing", card: 3 }, 0)).toBe("Writing card 3");
    expect(stageLabel({ kind: "reading", done: 4, total: 12 }, 0)).toBe("Reading 4 of 12 pages");
  });
});
