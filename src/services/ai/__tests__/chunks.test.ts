import { AiGenerationService, type SourceChunk } from "../AiGenerationService";
import { chunkLabel, planChunks, shouldChunk, type ChunkUnit } from "../chunks";
import { stageLabel, type GenerationStage } from "../stages";
import type { HttpClient, HttpRequest, HttpResponse } from "../HttpClient";

function sseFor(cards: Array<[string, string, number?]>): string {
  const content = cards
    .map(([front, back, page]) => `FRONT: ${front}\nBACK: ${back}\n${page ? `PAGE: ${page}\n` : ""}===END===\n`)
    .join("");
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
}

/** One scripted reply per request, in order; a string entry fails that request. */
class ChunkHttp implements HttpClient {
  requests: HttpRequest[] = [];
  constructor(private readonly replies: Array<string | Error>) {}
  async request(): Promise<HttpResponse> {
    throw new Error("not streamed");
  }
  async stream(req: HttpRequest, onChunk: (t: string) => void): Promise<void> {
    const reply = this.replies[this.requests.length];
    this.requests.push(req);
    if (reply instanceof Error) throw reply;
    onChunk(reply ?? "data: [DONE]\n\n");
  }
}

const openai = { provider: "openai" as const, model: "m", apiKey: "k" };
const units = (n: number, chars = 2_000, section?: (page: number) => string): ChunkUnit[] =>
  Array.from({ length: n }, (_, i) => ({ page: i + 1, chars, section: section?.(i + 1) }));
const lastUser = (req: HttpRequest): string => {
  const body = JSON.parse(req.body ?? "{}") as { messages: Array<{ role: string; content: string }> };
  return body.messages.map((m) => m.content).join("\n");
};

describe("planning chunks", () => {
  it("leaves a short selection whole", () => {
    expect(shouldChunk(units(8))).toBe(false);
    expect(shouldChunk(units(9))).toBe(true);
    expect(shouldChunk(units(3, 12_000))).toBe(true);
  });

  it("starts small so the first cards come early, then takes bigger steps", () => {
    const chunks = planChunks(units(30));
    expect(chunks[0].pages).toEqual([1, 2, 3]);
    expect(chunks[1].pages).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(chunks.flatMap((c) => c.pages)).toEqual(units(30).map((u) => u.page));
  });

  it("breaks at a section once a chunk is half full, and never splits a page", () => {
    const section = (p: number) => (p <= 2 ? "Intro" : p <= 9 ? "Variance" : "Tests");
    const chunks = planChunks(units(14, 2_000, section));
    expect(chunks.map((c) => c.pages)).toEqual([[1, 2], [3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13, 14]]);
    expect(chunks.map((c) => c.sections)).toEqual([["Intro"], ["Variance"], ["Tests"]]);
    // A page larger than the limit is still one chunk on its own.
    expect(planChunks([{ page: 1, chars: 50_000 }, { page: 2, chars: 10 }]).map((c) => c.pages)).toEqual([[1], [2]]);
  });

  it("names a chunk by its section, or by its pages", () => {
    expect(chunkLabel({ pages: [4, 5], sections: ["Variance"] })).toBe("Variance");
    expect(chunkLabel({ pages: [4, 5], sections: ["Variance", "Tests"] })).toBe("Variance …");
    expect(chunkLabel({ pages: [4, 5, 6], sections: [] })).toBe("pp. 4–6");
    expect(chunkLabel({ pages: [7], sections: [] })).toBe("p. 7");
  });
});

describe("generating chunk by chunk", () => {
  const chunk = (pages: number[], text: string, log?: string[]): SourceChunk => ({
    pages,
    label: `pp. ${pages[0]}`,
    load: async () => {
      log?.push(`load ${pages[0]}`);
      return text;
    },
  });

  it("runs the chunks in order, reads ahead, and drops a card another chunk made", async () => {
    const http = new ChunkHttp([sseFor([["Q1", "A"], ["Q2", "A"]]), sseFor([["q1 ", "A"], ["Q3", "A"]])]);
    const log: string[] = [];
    const seen: string[] = [];
    const stages: GenerationStage[] = [];
    const result = await new AiGenerationService(http).generateChunked(
      openai,
      { prompt: "", chunks: [chunk([1, 2], "first part", log), chunk([3, 4], "second part", log)], extraContext: "ATTACHED NOTE" },
      {
        onCard: (c) => {
          seen.push(c.front);
          log.push(`card ${c.front}`);
        },
        onStage: (s) => stages.push(s),
      },
    );
    expect(seen).toEqual(["Q1", "Q2", "Q3"]);
    expect(result).toMatchObject({ doneChunks: 2, emptyChunks: 0 });
    // The second chunk was read before the first one's cards arrived.
    expect(log.indexOf("load 3")).toBeLessThan(log.indexOf("card Q1"));
    expect(lastUser(http.requests[0])).toContain("ATTACHED NOTE");
    expect(lastUser(http.requests[1])).not.toContain("ATTACHED NOTE");
    expect(lastUser(http.requests[1])).toContain("- Q2");
    const writing = stages.find((s) => s.kind === "section" && s.inner?.kind === "writing");
    expect(writing && stageLabel(writing, 0)).toBe("Section 1 of 2 · pp. 1 · Writing card 1");
  });

  it("skips a chunk with no text and says how many there were", async () => {
    const http = new ChunkHttp([sseFor([["Q1", "A"]])]);
    const result = await new AiGenerationService(http).generateChunked(
      openai,
      { prompt: "", chunks: [chunk([1], ""), chunk([2], "text")] },
      { onCard: () => {} },
    );
    expect(http.requests).toHaveLength(1);
    expect(result).toMatchObject({ doneChunks: 1, emptyChunks: 1 });
  });

  it("names a chunk's own earlier cards before cards from elsewhere when the list is capped", async () => {
    const existing = Array.from({ length: 70 }, (_, i) => ({ front: `Other ${i}`, back: "A", notes: "", page: 50 }));
    existing.unshift({ front: "Own card", back: "A", notes: "", page: 3 });
    const http = new ChunkHttp([sseFor([])]);
    await new AiGenerationService(http).generateChunked(
      openai,
      { prompt: "", chunks: [chunk([3], "text")], existingCards: existing },
      { onCard: () => {} },
    );
    expect(lastUser(http.requests[0])).toContain("- Own card");
    expect(lastUser(http.requests[0])).not.toContain("- Other 0\n");
  });

  it("keeps what arrived when a later chunk fails, and says the rest is unread", async () => {
    const http = new ChunkHttp([sseFor([["Q1", "A"]]), new Error("gone")]);
    const result = await new AiGenerationService(http).generateChunked(
      openai,
      { prompt: "", chunks: [chunk([1], "a"), chunk([2], "b"), chunk([3], "c")] },
      { onCard: () => {} },
    );
    expect(result.cards.map((c) => c.front)).toEqual(["Q1"]);
    expect(result.error).toBeDefined();
    expect(result.truncated).toBe(true);
    expect(result.covered).toBe(false);
  });

  it("fails outright when the first chunk fails", async () => {
    const http = new ChunkHttp([new Error("gone")]);
    await expect(
      new AiGenerationService(http).generateChunked(openai, { prompt: "", chunks: [chunk([1], "a")] }, { onCard: () => {} }),
    ).rejects.toMatchObject({ code: "network_error" });
  });

  it("stops between chunks when asked, keeping the cards so far", async () => {
    const controller = new AbortController();
    const http = new ChunkHttp([sseFor([["Q1", "A"]]), sseFor([["Q2", "A"]])]);
    const result = await new AiGenerationService(http).generateChunked(
      openai,
      { prompt: "", chunks: [chunk([1], "a"), chunk([2], "b")] },
      { onCard: () => controller.abort() },
      controller.signal,
    );
    expect(result.cards.map((c) => c.front)).toEqual(["Q1"]);
    expect(http.requests).toHaveLength(1);
  });
});
