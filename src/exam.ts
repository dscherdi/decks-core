// The exam engine on its own, for callers that ship to a browser and cannot carry the whole package.
export {
  ExamAttempt,
  buildExamPool,
  drawExamQuestions,
  examQuestionText,
  examUnits,
  sampleExamUnits,
  groupExamExercises,
  EXAM_TARGET_BLANK,
  EXAM_INERT_BLANK,
} from "./services/ExamAttempt";
export type {
  ExamExercise,
  ExamMaterial,
  ExamQuestion,
  ExamGivenAnswer,
  ExamQuestionOutcome,
  ExamPool,
} from "./services/ExamAttempt";
export { DEFAULT_EXAM_SETTINGS } from "./database/types";
export type { ExamSettings, TypedGradingMode } from "./database/types";
