import type { ExamAttempt, ExamJudgeItem } from "./ExamAttempt";

export type ExamJudgeVerdict = "correct" | "incorrect" | "unsure";

/** Judges typed answers by id; throws when the check could not run at all. */
export type ExamJudge = (
  items: ExamJudgeItem[],
  signal?: AbortSignal
) => Promise<Map<string, ExamJudgeVerdict>>;

export interface JudgeOutcome {
  /** Question indices the student must now grade themselves. */
  unresolved: number[];
  /** True when the judge was unavailable or failed. */
  failed: boolean;
}

/**
 * Judge the pending typed answers and apply the verdicts. Anything left
 * unsure, or everything when there is no judge or it fails, is returned for
 * self-grading.
 */
export async function judgePending(
  attempt: ExamAttempt,
  judge: ExamJudge | null,
  indices?: readonly number[],
  signal?: AbortSignal
): Promise<JudgeOutcome> {
  const items = attempt.pendingJudgements(indices);
  let failed = judge === null && items.length > 0;
  if (judge && items.length > 0) {
    try {
      const verdicts = await judge(items, signal);
      for (const item of items) {
        const verdict = verdicts.get(item.id);
        if (verdict === "correct" || verdict === "incorrect") {
          attempt.applyJudgement(Number(item.id), item.given, verdict === "correct");
        }
      }
    } catch {
      failed = true;
    }
  }
  const scope = indices ?? attempt.questions.map((_q, i) => i);
  return { unresolved: scope.filter((i) => attempt.needsSelfVerdict(i)), failed };
}
