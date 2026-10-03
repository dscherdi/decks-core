import type { ILogger } from "../../database/DatabaseService.interface";
import type { ExamJudgeItem } from "../ExamAttempt";
import type { ExamJudgeVerdict } from "../ExamJudging";
import type { HttpClient } from "./HttpClient";
import { createProvider } from "./providers";
import { DECKS_GRADE } from "./models";
import { parseGradeVerdicts } from "./grading";
import type { AiProviderConfig } from "./types";

/** Most answers sent in one request. */
export const GRADE_CHUNK_SIZE = 40;

/** Grades typed exam answers by meaning through the backend. */
export class AiGradingService {
  constructor(
    private readonly http: HttpClient,
    private readonly logger?: ILogger,
  ) {}

  /** Only the hosted provider grades by meaning. */
  static supports(config: AiProviderConfig): boolean {
    return config.provider === "decks-pro";
  }

  /** Verdicts by item id; items the backend left out are absent. Throws when a request fails. */
  async grade(
    config: AiProviderConfig,
    items: ExamJudgeItem[],
    signal?: AbortSignal,
  ): Promise<Map<string, ExamJudgeVerdict>> {
    const out = new Map<string, ExamJudgeVerdict>();
    if (items.length === 0 || !AiGradingService.supports(config)) return out;
    const provider = createProvider({ ...config, model: DECKS_GRADE }, this.http);
    const asked = new Set(items.map((i) => i.id));
    for (let start = 0; start < items.length; start += GRADE_CHUNK_SIZE) {
      const chunk = items.slice(start, start + GRADE_CHUNK_SIZE);
      this.logger?.debug(`AI grading of ${chunk.length} answers`);
      const raw = await provider.complete({ system: "", user: "", rawGrade: chunk, json: false, signal });
      for (const [id, verdict] of parseGradeVerdicts(raw)) {
        if (asked.has(id)) out.set(id, verdict);
      }
    }
    return out;
  }
}
