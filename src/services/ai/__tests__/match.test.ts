import { unmatchedCards } from "../concepts";
import { lexicalCandidates, overlapTokens } from "../overlap";
import { AiMatchService } from "../AiMatchService";
import type { HttpClient, HttpRequest } from "../HttpClient";

const reply = (content: object) => ({
  status: 200,
  text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
});

function http(respond: (body: Record<string, unknown>) => object) {
  const sent: Array<Record<string, unknown>> = [];
  const client: HttpClient = {
    request: async (req: HttpRequest) => {
      const body = JSON.parse(String(req.body)) as Record<string, unknown>;
      sent.push(body);
      return reply(respond(body));
    },
  };
  return { client, sent };
}

const PRO = { provider: "decks-pro" as const, model: "decks-tier-fast", apiKey: "dk_x" };

describe("unmatchedCards", () => {
  const concepts = [{ id: "k1", term: "Mitochondrion", page: 2, blurb: "" }];

  it("keeps only identified cards that neither name a concept nor carry one", () => {
    const out = unmatchedCards(concepts, [
      { id: "a", text: "What makes ATP?\nThe mitochondrion", front: "What makes ATP?", back: "The mitochondrion" },
      { id: "b", text: "Powerhouse of the cell?\nIt makes energy", front: "Powerhouse of the cell?", back: "It makes energy", page: 2 },
      { id: "c", text: "x", conceptId: "k1" },
      { text: "no id" },
    ]);
    expect(out).toEqual([{ id: "b", front: "Powerhouse of the cell?", back: "It makes energy", page: 2 }]);
  });
});

describe("lexicalCandidates", () => {
  it("pairs a staged card with the existing cards sharing most words", () => {
    const out = lexicalCandidates(
      [{ id: "s1", front: "Who discovered penicillin?", back: "Alexander Fleming" }],
      [
        { id: "e1", front: "Penicillin was discovered by whom?", back: "Fleming" },
        { id: "e2", front: "Capital of France?", back: "Paris" },
      ],
    );
    expect(out.map((c) => c.existingId)).toEqual(["e1"]);
  });

  it("reads scripts without spaces as character pairs", () => {
    expect([...overlapTokens("光合作用")]).toEqual(["光合", "合作", "作用"]);
  });
});

describe("AiMatchService", () => {
  it("maps cards under the concept-map sentinel and drops unknown concepts", async () => {
    const { client, sent } = http(() => ({ matches: [{ id: "b", concept: "k1" }, { id: "c", concept: "k9" }] }));
    const out = await new AiMatchService(client).mapConcepts(
      PRO,
      [{ id: "k1", term: "Mitochondrion", page: 2, blurb: "Makes ATP" }],
      [
        { id: "b", front: "f", back: "b" },
        { id: "c", front: "f", back: "b" },
      ],
    );
    expect([...out]).toEqual([
      ["b", "k1"],
      ["c", null],
    ]);
    expect(sent[0].model).toBe("decks-concept-map");
  });

  it("reports the existing cards a staged card duplicates", async () => {
    const { client, sent } = http((body) => {
      const pairs = (body.overlap as { pairs: Array<{ id: string }> }).pairs;
      return { pairs: pairs.map((p, i) => ({ id: p.id, duplicate: i === 0 })) };
    });
    const cards = new Map([
      ["s1", { id: "s1", front: "Who discovered penicillin?", back: "Fleming" }],
      ["e1", { id: "e1", front: "Penicillin was discovered by?", back: "Fleming" }],
      ["e2", { id: "e2", front: "When was penicillin discovered?", back: "1928" }],
    ]);
    const out = await new AiMatchService(client).findDuplicates(
      PRO,
      [
        { stagedId: "s1", existingId: "e1", score: 0.5 },
        { stagedId: "s1", existingId: "e2", score: 0.3 },
      ],
      cards,
    );
    expect([...out]).toEqual([["s1", ["e1"]]]);
    expect(sent[0].model).toBe("decks-overlap");
  });

  it("does nothing for other providers", async () => {
    const { client, sent } = http(() => ({}));
    const service = new AiMatchService(client);
    const config = { provider: "claude" as const, model: "m", apiKey: "k" };
    expect((await service.mapConcepts(config, [{ id: "k", term: "t", page: 1, blurb: "" }], [{ id: "a", front: "f", back: "" }])).size).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
