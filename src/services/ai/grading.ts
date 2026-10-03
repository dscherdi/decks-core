import type { ExamJudgeVerdict } from "../ExamJudging";

const VERDICTS = new Set<string>(["correct", "incorrect", "unsure"]);

/** The backend's grading reply: `{"verdicts":[{"id","verdict"}]}`. Unknown entries are dropped. */
export function parseGradeVerdicts(raw: string): Map<string, ExamJudgeVerdict> {
  const out = new Map<string, ExamJudgeVerdict>();
  let parsed: { verdicts?: Array<{ id?: unknown; verdict?: unknown }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return out;
  }
  for (const entry of Array.isArray(parsed?.verdicts) ? parsed.verdicts : []) {
    if (typeof entry?.id === "string" && typeof entry.verdict === "string" && VERDICTS.has(entry.verdict)) {
      out.set(entry.id, entry.verdict as ExamJudgeVerdict);
    }
  }
  return out;
}
