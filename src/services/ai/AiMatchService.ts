import type { ILogger } from "../../database/DatabaseService.interface";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import { DECKS_CONCEPT_MAP, DECKS_OVERLAP } from "./models";
import type { ConceptMapCard, SourceConcept } from "./concepts";
import type { OverlapCandidate, OverlapCard } from "./overlap";
import type { AiProviderConfig } from "./types";

/** Most cards or pairs sent in one request. */
export const MATCH_CHUNK_SIZE = 40;

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Mapping cards to concepts and finding near-duplicates, through the backend. */
export class AiMatchService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  /** Only the hosted provider runs these checks. */
  static supports(config: AiProviderConfig): boolean {
    return config.provider === "decks-pro";
  }

  /** The concept each card tests, or null for none; cards the backend left out are absent. */
  async mapConcepts(
    config: AiProviderConfig,
    concepts: ReadonlyArray<SourceConcept & { id: string }>,
    cards: readonly ConceptMapCard[],
    signal?: AbortSignal,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (cards.length === 0 || concepts.length === 0 || !AiMatchService.supports(config)) return out;
    const provider = createProvider({ ...config, model: DECKS_CONCEPT_MAP }, this.http);
    const known = new Set(concepts.map((c) => c.id));
    const asked = new Set(cards.map((c) => c.id));
    const payload = concepts.map(({ id, term, page, blurb }) => ({ id, term, page, blurb }));
    for (let start = 0; start < cards.length; start += MATCH_CHUNK_SIZE) {
      const chunk = cards.slice(start, start + MATCH_CHUNK_SIZE);
      this.logger?.debug(`AI concept mapping of ${chunk.length} cards`);
      const raw = await provider.complete({
        system: "",
        user: "",
        rawConceptMap: { concepts: payload, cards: chunk },
        json: false,
        signal,
      });
      const parsed = parseJson<{ matches?: Array<{ id?: unknown; concept?: unknown }> }>(raw);
      for (const m of parsed?.matches ?? []) {
        if (typeof m.id !== "string" || !asked.has(m.id)) continue;
        out.set(m.id, typeof m.concept === "string" && known.has(m.concept) ? m.concept : null);
      }
    }
    return out;
  }

  /** Candidate pairs that test the same fact, as `stagedId -> existingIds`. */
  async findDuplicates(
    config: AiProviderConfig,
    candidates: readonly OverlapCandidate[],
    cards: ReadonlyMap<string, OverlapCard>,
    signal?: AbortSignal,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (candidates.length === 0 || !AiMatchService.supports(config)) return out;
    const provider = createProvider({ ...config, model: DECKS_OVERLAP }, this.http);
    const pairs = candidates
      .map((c, i) => {
        const a = cards.get(c.stagedId);
        const b = cards.get(c.existingId);
        return a && b ? { id: String(i), candidate: c, a: { front: a.front, back: a.back }, b: { front: b.front, back: b.back } } : null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const byId = new Map(pairs.map((p) => [p.id, p.candidate]));
    for (let start = 0; start < pairs.length; start += MATCH_CHUNK_SIZE) {
      const chunk = pairs.slice(start, start + MATCH_CHUNK_SIZE).map(({ id, a, b }) => ({ id, a, b }));
      this.logger?.debug(`AI overlap check of ${chunk.length} pairs`);
      const raw = await provider.complete({ system: "", user: "", rawOverlap: chunk, json: false, signal });
      const parsed = parseJson<{ pairs?: Array<{ id?: unknown; duplicate?: unknown }> }>(raw);
      for (const p of parsed?.pairs ?? []) {
        const candidate = typeof p.id === "string" ? byId.get(p.id) : undefined;
        if (!candidate || p.duplicate !== true) continue;
        out.set(candidate.stagedId, [...(out.get(candidate.stagedId) ?? []), candidate.existingId]);
      }
    }
    return out;
  }
}
