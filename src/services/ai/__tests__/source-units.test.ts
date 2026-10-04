import { AiConceptService } from "../AiConceptService";
import { isPdfSourceKey, noteUnits, textSourceKey, unitLabel, unitSource } from "../source-units";
import type { HttpClient, HttpRequest, HttpResponse } from "../HttpClient";

const para = (word: string, n = 60) => Array.from({ length: n }, () => word).join(" ");

describe("a note as numbered units", () => {
  it("splits at its headings and drops the frontmatter", () => {
    const note = `---\ntags: [x]\n---\n# Variance\n${para("spread")}\n\n## Median\n${para("middle")}\n`;
    const units = noteUnits(note);
    expect(units.map((u) => [u.n, u.heading])).toEqual([
      [1, "Variance"],
      [2, "Median"],
    ]);
    expect(units[0].text).not.toContain("tags");
  });

  it("merges a short section into the next, and splits a long one between paragraphs", () => {
    const note = `# Short\nTiny.\n# Long\n${Array.from({ length: 12 }, (_, i) => para(`para${i}`, 100)).join("\n\n")}`;
    const units = noteUnits(note);
    expect(units[0].heading).toBe("Short");
    expect(units[0].text).toContain("Tiny.");
    expect(units[0].text).toContain("# Long");
    expect(units.length).toBeGreaterThan(1);
    expect(units.every((u) => u.text.length <= 4_000)).toBe(true);
    expect(units.map((u) => u.n)).toEqual(units.map((_, i) => i + 1));
  });

  it("keeps a note with no headings as one unit", () => {
    expect(noteUnits("Just a short paragraph.")).toEqual([{ n: 1, text: "Just a short paragraph.", heading: undefined }]);
  });

  it("labels units on the wire as pages, and to the reader as sections", () => {
    expect(unitSource([{ n: 1, text: "a" }, { n: 2, text: "b" }])).toBe("[p. 1]\na\n\n[p. 2]\nb");
    expect(unitLabel(3, false, "Median")).toBe("§3 · Median");
    expect(unitLabel(12, true)).toBe("p. 12");
  });

  it("keys text by its content, apart from PDFs", () => {
    expect(textSourceKey("Hello  world")).toBe(textSourceKey("Hello world\n"));
    expect(textSourceKey("Hello world")).not.toBe(textSourceKey("Hello there"));
    expect(isPdfSourceKey(textSourceKey("x"))).toBe(false);
    expect(isPdfSourceKey("2kd_1a2b")).toBe(true);
    expect(isPdfSourceKey(null)).toBe(false);
  });
});

/** Answers each extraction with one concept per page it was sent, or cuts the reply off. */
class ConceptHttp implements HttpClient {
  sent: number[][] = [];
  constructor(private readonly cutOff: (pages: number[]) => boolean = () => false) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    const body = JSON.parse(req.body ?? "{}") as { messages: Array<{ content: string }> };
    const text = body.messages.map((m) => m.content).join("\n");
    const pages = [...text.matchAll(/\[p\. (\d+)\]/g)].map((m) => Number(m[1]));
    this.sent.push(pages);
    const cut = this.cutOff(pages);
    const answered = cut ? pages.slice(0, 2) : pages;
    const content = answered.map((p) => `TERM: Concept ${p}\nPAGE: ${p}\nBLURB: b\n===END===`).join("\n");
    return {
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content }, finish_reason: cut ? "length" : "stop" }] }),
    };
  }
}

const openai = { provider: "openai" as const, model: "m", apiKey: "k" };
const units = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `text of unit ${i + 1}` }));

describe("extracting concepts a chunk at a time", () => {
  it("reads every unit, a few per request, reporting each chunk as it lands", async () => {
    const http = new ConceptHttp();
    const progress: number[] = [];
    const chunks: number[][] = [];
    const result = await new AiConceptService(http).extractChunked(openai, units(14), {
      onChunk: (_found, read) => {
        chunks.push(read);
      },
      onProgress: (done) => progress.push(done),
    });
    expect(http.sent.every((pages) => pages.length <= 6)).toBe(true);
    expect(result.read).toEqual(units(14).map((u) => u.n));
    expect(result.concepts).toHaveLength(14);
    expect(chunks).toHaveLength(3);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(14);
  });

  it("counts only what a cut-off reply finished, and reads the rest again", async () => {
    let first = true;
    const http = new ConceptHttp((pages) => {
      const cut = first && pages.length === 6;
      first = false;
      return cut;
    });
    const result = await new AiConceptService(http).extractChunked(openai, units(6));
    expect(result.read).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.concepts.map((c) => c.page).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(http.sent[0]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(http.sent.slice(1).flat().sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
  });

  it("stops when cancelled, keeping the chunks already read", async () => {
    const controller = new AbortController();
    const http = new ConceptHttp();
    const result = await new AiConceptService(http).extractChunked(
      openai,
      units(30),
      { onChunk: () => controller.abort() },
      controller.signal,
    );
    expect(result.read.length).toBeGreaterThan(0);
    expect(result.read.length).toBeLessThan(30);
  });
});
