import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import {
  buildConceptMessages,
  cleanConcepts,
  parseConcepts,
  type ConceptRequest,
  type SourceConcept,
} from "./concepts";
import { unitSource, type SourceUnit } from "./source-units";
import type { ProviderCompleteRequest } from "./providers/AiProvider";
import type { AiProviderConfig } from "./types";
import { AiError } from "./types";

export interface ConceptChunkHandlers {
  /** A chunk's concepts and the units it read, as each chunk lands, so each can be saved. */
  onChunk?: (found: SourceConcept[], read: number[]) => void | Promise<void>;
  /** Units read so far out of all of them. */
  onProgress?: (done: number, total: number) => void;
}

const CHUNK_UNITS = 6;
const CHUNK_CHARS = 12_000;
const PARALLEL_CHUNKS = 2;

/** Consecutive units grouped up to the chunk limits; a unit is never split. */
function planUnitChunks(units: readonly SourceUnit[]): SourceUnit[][] {
  const chunks: SourceUnit[][] = [];
  let current: SourceUnit[] = [];
  let size = 0;
  for (const unit of units) {
    if (current.length > 0 && (current.length >= CHUNK_UNITS || size + unit.text.length > CHUNK_CHARS)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += unit.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface ConceptResult {
  concepts: SourceConcept[];
  debug?: { provider: string; model: string; system: string; user: string; raw: string };
}

/**
 * One extraction pass over a source, producing the examinable-concept ledger.
 * Runs once per source and is cached by the caller, not per generation run.
 */
export class AiConceptService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  /**
   * Read a source a few units at a time, two chunks in flight, reporting each
   * chunk as it lands. A reply cut off by its length counts only the units it
   * cited as read, and the rest are read again in smaller chunks.
   */
  async extractChunked(
    config: AiProviderConfig,
    units: readonly SourceUnit[],
    handlers: ConceptChunkHandlers = {},
    signal?: AbortSignal,
  ): Promise<{ concepts: SourceConcept[]; read: number[] }> {
    if (config.provider !== "openai-compatible" && !config.apiKey) {
      throw new AiError("missing_key", "No API key configured for this provider");
    }
    const provider = createProvider(config, this.http);
    const serverSide = provider.buildsPromptServerSide?.() === true;
    const queue = planUnitChunks(units.filter((u) => u.text.trim()));
    const total = queue.reduce((n, chunk) => n + chunk.length, 0);
    const concepts: SourceConcept[] = [];
    const read: number[] = [];
    let failure: unknown = null;
    handlers.onProgress?.(0, total);

    const runChunk = async (chunk: SourceUnit[]): Promise<void> => {
      const source = unitSource(chunk);
      const { system, user } = serverSide ? { system: "", user: "" } : buildConceptMessages({ source });
      const req: ProviderCompleteRequest = {
        system,
        user,
        rawConceptSource: serverSide ? source : undefined,
        json: false,
        signal,
      };
      const reply = provider.completeWithMeta
        ? await provider.completeWithMeta(req)
        : { text: await provider.complete(req), finishReason: undefined };
      const numbers = new Set(chunk.map((u) => u.n));
      const found = cleanConcepts(parseConcepts(reply.text), numbers);
      let done = chunk;
      if (reply.finishReason === "length" && chunk.length > 1) {
        // The last unit it cited may be cut short, so it is read again with the ones it never reached.
        const cited = [...new Set(found.map((c) => c.page))].sort((a, b) => a - b);
        const finished = new Set(cited.slice(0, -1));
        done = chunk.filter((u) => finished.has(u.n));
        const rest = chunk.filter((u) => !finished.has(u.n));
        const half = Math.ceil(rest.length / 2);
        queue.unshift(rest.slice(0, half), ...(rest.length > half ? [rest.slice(half)] : []));
      }
      const doneNumbers = new Set(done.map((u) => u.n));
      const kept = found.filter((c) => doneNumbers.has(c.page));
      concepts.push(...kept);
      read.push(...doneNumbers);
      await handlers.onChunk?.(kept, [...doneNumbers]);
      handlers.onProgress?.(read.length, total);
    };

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && failure === null && !signal?.aborted) {
        const chunk = queue.shift();
        if (!chunk) break;
        try {
          await runChunk(chunk);
        } catch (e) {
          failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, worker));
    if (failure !== null && !signal?.aborted) throw failure;
    return { concepts, read: read.sort((a, b) => a - b) };
  }

  async extract(
    config: AiProviderConfig,
    req: ConceptRequest,
    signal?: AbortSignal,
  ): Promise<ConceptResult> {
    if (!req.source.trim()) return { concepts: [] };
    if (config.provider !== "openai-compatible" && !config.apiKey) {
      throw new AiError("missing_key", "No API key configured for this provider");
    }

    const provider = createProvider(config, this.http);
    const serverSide = provider.buildsPromptServerSide?.() === true;
    const { system, user } = serverSide
      ? { system: "", user: "" }
      : buildConceptMessages(req);

    this.logger?.debug("AI concept extraction");

    const raw = await provider.complete({
      system,
      user,
      rawConceptSource: serverSide ? req.source : undefined,
      json: false,
      signal,
    });

    return {
      concepts: parseConcepts(raw),
      debug: req.debug
        ? { provider: config.provider, model: config.model, system, user, raw }
        : undefined,
    };
  }
}
