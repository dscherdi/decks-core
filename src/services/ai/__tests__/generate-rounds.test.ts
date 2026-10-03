import { AiGenerationService } from "../AiGenerationService";
import { continuationCards, offersContinue } from "../thread";
import type { HttpClient, HttpRequest, HttpResponse } from "../HttpClient";

// OpenAI-style SSE carrying the delimited card format the parser expects.
function sseFor(cards: Array<[string, string]>, finish?: "length"): string {
  const content = cards
    .map(([front, back]) => `FRONT: ${front}\nBACK: ${back}\n===END===\n`)
    .join("");
  const done = finish
    ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`
    : "";
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n${done}data: [DONE]\n\n`;
}

// One scripted stream per round; rounds past the script produce nothing.
class RoundsHttp implements HttpClient {
  requests: HttpRequest[] = [];
  private calls = 0;
  constructor(private readonly scripts: string[]) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "" } }] }) };
  }
  async stream(req: HttpRequest, onChunk: (t: string) => void): Promise<void> {
    this.requests.push(req);
    onChunk(this.scripts[this.calls] ?? "data: [DONE]\n\n");
    this.calls++;
  }
}

const openai = { provider: "openai" as const, model: "gpt-4o-mini", apiKey: "sk" };
const card = (front: string) => ({ front, back: "A", notes: "" });

describe("generateRounds", () => {
  it("accumulates new cards across rounds, drops repeats, and stops when a round adds nothing", async () => {
    const http = new RoundsHttp([
      sseFor([["Q1", "A1"], ["Q2", "A2"]]),
      sseFor([["Q2", "A2"], ["Q3", "A3"]]),
      sseFor([["Q1", "A1"]]),
    ]);
    const seen: string[] = [];
    const result = await new AiGenerationService(http).generateRounds(
      openai,
      { prompt: "go", maxBatches: 5 },
      { onCard: (c) => seen.push(c.front) },
    );
    expect(seen).toEqual(["Q1", "Q2", "Q3"]);
    expect(result.cards.map((c) => c.front)).toEqual(["Q1", "Q2", "Q3"]);
    expect(http.requests).toHaveLength(3);
  });

  it("seeds the run with cards already on the table without emitting them", async () => {
    const http = new RoundsHttp([sseFor([["Q1", "A1"], ["Q4", "A4"]])]);
    const seen: string[] = [];
    await new AiGenerationService(http).generateRounds(
      openai,
      { prompt: "go", existingCards: [card("Q1")] },
      { onCard: (c) => seen.push(c.front) },
    );
    expect(seen).toEqual(["Q4"]);
  });

  it("keeps going after a cut-off round, and reports the cut", async () => {
    const http = new RoundsHttp([sseFor([["Q1", "A1"]], "length"), sseFor([["Q2", "A2"]], "length")]);
    const result = await new AiGenerationService(http).generateRounds(
      openai,
      { prompt: "go", maxBatches: 2 },
      { onCard: () => {} },
    );
    expect(result.cards).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("sends a hosted continue round the cards so far, and the first round none", async () => {
    const http = new RoundsHttp([sseFor([["Q2", "A2"]], "length"), sseFor([])]);
    await new AiGenerationService(http).generateRounds(
      { provider: "decks-pro", model: "decks-tier-fast", apiKey: "k" },
      { prompt: "go", existingCards: [card("Q1")], maxBatches: 2 },
      { onCard: () => {} },
    );
    const first = JSON.parse(http.requests[0].body ?? "{}");
    const second = JSON.parse(http.requests[1].body ?? "{}");
    expect(first.generatedSoFar.map((c: { front: string }) => c.front)).toEqual(["Q1"]);
    expect(second.generatedSoFar.map((c: { front: string }) => c.front)).toEqual(["Q1", "Q2"]);

    const fresh = new RoundsHttp([sseFor([["Q1", "A1"]])]);
    await new AiGenerationService(fresh).generateRounds(
      { provider: "decks-pro", model: "decks-tier-fast", apiKey: "k" },
      { prompt: "go" },
      { onCard: () => {} },
    );
    expect(JSON.parse(fresh.requests[0].body ?? "{}").generatedSoFar).toBeUndefined();
  });
});

describe("continuing a pile", () => {
  it("shows a continue round the pile, and a refinement nothing", () => {
    const rows = [{ card: card("Q1") }, { card: card("Q2") }];
    expect(continuationCards(rows, false)?.map((c) => c.front)).toEqual(["Q1", "Q2"]);
    expect(continuationCards(rows, true)).toBeUndefined();
    expect(continuationCards([], false)).toBeUndefined();
  });

  it("offers to continue after cards or a cut, never once the source is spent", () => {
    expect(offersContinue({ cards: [1] })).toBe(true);
    expect(offersContinue({ cards: [], truncated: true })).toBe(true);
    expect(offersContinue({ cards: [] })).toBe(false);
    expect(offersContinue({ cards: [1], covered: true })).toBe(false);
  });
});
