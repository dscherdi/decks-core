import type { Flashcard, TypedGradingMode } from "../database/types";
import { classifyExamBody, type ExamInvalidReason } from "./ExamClassifier";
import { checkTypeInGradability, getTypeInAnswerLine } from "./ExamGrading";

export interface CardHealthThresholds {
  leechThreshold: number;
  denseCardCharThreshold: number;
}

export type ExamHealthIssue =
  | { kind: "invalid-question"; reason: ExamInvalidReason }
  | { kind: "answer-too-long" };

// Exam validity is profile-relative, so callers supply the deck's exam
// context; without it (all pre-exam callers) examIssue is always null.
export interface ExamHealthContext {
  examEnabled: boolean;
  typedGrading: TypedGradingMode;
}

export interface CardHealth {
  isLeech: boolean;
  isDense: boolean;
  examIssue: ExamHealthIssue | null;
}

const TYPE_IN_TYPES = new Set(["header-paragraph", "table", "cloze"]);

function computeExamIssue(
  card: Pick<Flashcard, "back"> & Partial<Pick<Flashcard, "type" | "clozeText">>,
  examContext?: ExamHealthContext
): ExamHealthIssue | null {
  if (!examContext?.examEnabled || card.type === undefined) return null;
  if (card.type === "header-paragraph") {
    const classified = classifyExamBody(card.back ?? "");
    if (classified.kind === "invalid") {
      return { kind: "invalid-question", reason: classified.reason };
    }
  }
  if (examContext.typedGrading !== "self" && TYPE_IN_TYPES.has(card.type)) {
    const answer = getTypeInAnswerLine(card.back ?? "", card.clozeText ?? null);
    const gradability = checkTypeInGradability(answer);
    if (!gradability.gradable) return { kind: "answer-too-long" };
  }
  return null;
}

export function computeCardHealth(
  card: Pick<Flashcard, "lapses" | "back"> &
    Partial<Pick<Flashcard, "type" | "clozeText">>,
  thresholds: CardHealthThresholds,
  examContext?: ExamHealthContext
): CardHealth {
  return {
    isLeech: card.lapses >= thresholds.leechThreshold,
    isDense: (card.back?.length ?? 0) >= thresholds.denseCardCharThreshold,
    examIssue: computeExamIssue(card, examContext),
  };
}

export function isCardLeech(
  card: Pick<Flashcard, "lapses">,
  leechThreshold: number
): boolean {
  return card.lapses >= leechThreshold;
}

export function isCardDense(
  card: Pick<Flashcard, "back">,
  denseCardCharThreshold: number
): boolean {
  return (card.back?.length ?? 0) >= denseCardCharThreshold;
}
