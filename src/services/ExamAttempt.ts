/**
 * Headless exam attempt engine: eligibility pool, question draw, free
 * navigation with editable answers, objective grading, and the persisted
 * row shapes. The UI is a thin view over this class.
 */

import type {
  ExamAnswer,
  ExamDeckKind,
  ExamGradingMethod,
  ExamQuestionType,
  ExamSession,
  ExamSettings,
  Flashcard,
  TypedGradingMode,
} from "../database/types";
import { classifyExamBody, type ExamOption } from "./ExamClassifier";
import {
  checkTypeInGradability,
  getTypeInAnswerLine,
  indexSetsEqual,
  isTypedAnswerCorrect,
} from "./ExamGrading";
import { sampleWithoutReplacement, shuffleInPlace } from "../utils/sampling";

const PROMPT_SNAPSHOT_LENGTH = 200;
const CLOZE_REGEX = /==((?:(?!==).)+)==/g;

// Sentinel the UI swaps for the answer input; inert sibling blanks render
// as plain placeholders so no other question's answer is revealed.
export const EXAM_TARGET_BLANK = "⟦DECKS-EXAM-BLANK⟧";
export const EXAM_INERT_BLANK = "____";

export interface ExamQuestion {
  card: Flashcard;
  kind: ExamQuestionType;
  stem: string;
  options: ExamOption[] | null; // file order — grading indices
  displayOrder: number[] | null; // presentation permutation
  expectedAnswer: string | null;
  isCloze: boolean;
  clozeContext: string | null; // body with every segment blanked, target = sentinel
}

export type ExamGivenAnswer =
  | { kind: "options"; selected: number[] }
  | { kind: "typed"; text: string; selfVerdict: boolean | null };

export interface ExamQuestionOutcome {
  index: number;
  isCorrect: boolean;
  gradingMethod: ExamGradingMethod;
  correctAnswerText: string;
  givenAnswerText: string;
}

export type ExamSkipReason =
  | "not-exam-deck"
  | "unsupported-type"
  | "invalid-question"
  | "answer-too-long";

export interface ExamPool {
  eligible: ExamQuestion[];
  skipped: Array<{ card: Flashcard; reason: ExamSkipReason }>;
}

function truncatePrompt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PROMPT_SNAPSHOT_LENGTH
    ? flat
    : `${flat.slice(0, PROMPT_SNAPSHOT_LENGTH - 1)}…`;
}

/**
 * The card body with every cloze segment blanked. Only the target segment
 * becomes the sentinel (the answer input); siblings from the same body may
 * be other questions in the same exam, so none are ever revealed. Hidden
 * context reduces the body to the target's own line, as in review.
 */
function buildClozeContext(
  back: string,
  clozeOrder: number,
  showContext: boolean
): string {
  let order = 0;
  let targetLineIndex = 0;
  const lines = back.split("\n").map((line, lineIndex) =>
    line.replace(new RegExp(CLOZE_REGEX.source, "g"), () => {
      const isTarget = order === clozeOrder;
      if (isTarget) targetLineIndex = lineIndex;
      order++;
      return isTarget ? EXAM_TARGET_BLANK : EXAM_INERT_BLANK;
    })
  );
  return showContext ? lines.join("\n") : lines[targetLineIndex];
}

function buildQuestion(
  card: Flashcard,
  typedGrading: TypedGradingMode,
  showClozeContext: boolean
): { question: ExamQuestion } | { skip: ExamSkipReason } {
  if (card.type === "multiple-choice") {
    const classified = classifyExamBody(card.back);
    if (classified.kind !== "mcq") return { skip: "invalid-question" };
    return {
      question: {
        card,
        kind: "multiple-choice",
        stem: classified.stem ? `${card.front}\n\n${classified.stem}` : card.front,
        options: classified.options,
        displayOrder: null,
        expectedAnswer: null,
        isCloze: false,
        clozeContext: null,
      },
    };
  }

  if (
    card.type === "header-paragraph" ||
    card.type === "table" ||
    card.type === "cloze"
  ) {
    // A body that classifies as a question under this deck belongs to the
    // multiple-choice rule; as a type-in it would grade against option text.
    if (
      card.type === "header-paragraph" &&
      classifyExamBody(card.back).kind !== "plain"
    ) {
      return { skip: "invalid-question" };
    }
    const isCloze = card.type === "cloze";
    const answerLine = getTypeInAnswerLine(card.back, isCloze ? card.clozeText : null);
    if (typedGrading !== "self") {
      const gradability = checkTypeInGradability(answerLine);
      if (!gradability.gradable) return { skip: "answer-too-long" };
    }
    return {
      question: {
        card,
        kind: "type-in",
        stem: card.front,
        options: null,
        displayOrder: null,
        expectedAnswer: answerLine,
        isCloze,
        clozeContext: isCloze
          ? buildClozeContext(card.back, card.clozeOrder ?? 0, showClozeContext)
          : null,
      },
    };
  }

  return { skip: "unsupported-type" };
}

/** Filter a gathered selection down to exam-eligible questions. */
export function buildExamPool(
  cards: Flashcard[],
  examEnabledByDeckId: ReadonlyMap<string, boolean>,
  typedGrading: TypedGradingMode,
  showClozeContext = true
): ExamPool {
  const eligible: ExamQuestion[] = [];
  const skipped: ExamPool["skipped"] = [];
  for (const card of cards) {
    if (examEnabledByDeckId.get(card.deckId) !== true) {
      skipped.push({ card, reason: "not-exam-deck" });
      continue;
    }
    const built = buildQuestion(card, typedGrading, showClozeContext);
    if ("skip" in built) {
      skipped.push({ card, reason: built.skip });
    } else {
      eligible.push(built.question);
    }
  }
  return { eligible, skipped };
}

/** Draw and order the attempt's questions per the settings. */
export function drawExamQuestions(
  pool: ExamQuestion[],
  settings: ExamSettings,
  rng: () => number = Math.random
): ExamQuestion[] {
  const count =
    settings.questionCount > 0
      ? Math.min(settings.questionCount, pool.length)
      : pool.length;
  let drawn =
    settings.selectionMode === "random"
      ? sampleWithoutReplacement(pool, count, rng)
      : pool.slice(0, count);
  if (settings.shuffleQuestions) drawn = shuffleInPlace([...drawn], rng);
  return drawn.map((q) => ({
    ...q,
    displayOrder:
      q.options === null
        ? null
        : settings.shuffleOptions
          ? shuffleInPlace(q.options.map((_o, i) => i), rng)
          : q.options.map((_o, i) => i),
  }));
}

export class ExamAttempt {
  readonly id: string;
  readonly questions: ReadonlyArray<ExamQuestion>;
  readonly settings: ExamSettings;
  currentIndex = 0;

  private readonly deckKey: string;
  private readonly deckKind: ExamDeckKind;
  private readonly now: () => Date;
  private readonly startedAt: Date;
  private readonly answers = new Map<number, ExamGivenAnswer>();
  private readonly locked = new Map<number, ExamQuestionOutcome>();
  private readonly screenTimeMs = new Map<number, number>();

  constructor(input: {
    questions: ExamQuestion[];
    settings: ExamSettings;
    deckKey: string;
    deckKind: ExamDeckKind;
    now?: () => Date;
  }) {
    this.questions = input.questions;
    this.settings = input.settings;
    this.deckKey = input.deckKey;
    this.deckKind = input.deckKind;
    this.now = input.now ?? ((): Date => new Date());
    this.startedAt = this.now();
    this.id = `exam_${this.startedAt.getTime()}_${Math.random()
      .toString(36)
      .substring(2, 11)}`;
  }

  goTo(i: number): void {
    if (i >= 0 && i < this.questions.length) this.currentIndex = i;
  }

  next(): void {
    this.goTo(this.currentIndex + 1);
  }

  previous(): void {
    this.goTo(this.currentIndex - 1);
  }

  /** No-op once the question is locked (immediate feedback mode). */
  setAnswer(i: number, given: ExamGivenAnswer): void {
    if (this.locked.has(i)) return;
    this.answers.set(i, given);
  }

  getAnswer(i: number): ExamGivenAnswer | null {
    return this.answers.get(i) ?? null;
  }

  setSelfVerdict(i: number, correct: boolean): void {
    if (this.locked.has(i)) return;
    const given = this.answers.get(i);
    if (given?.kind === "typed") {
      this.answers.set(i, { ...given, selfVerdict: correct });
    }
  }

  isAnswered(i: number): boolean {
    const given = this.answers.get(i);
    if (!given) return false;
    if (given.kind === "options") return given.selected.length > 0;
    return given.text.trim() !== "" || given.selfVerdict !== null;
  }

  isLocked(i: number): boolean {
    return this.locked.has(i);
  }

  getOutcome(i: number): ExamQuestionOutcome | null {
    return this.locked.get(i) ?? null;
  }

  /** Immediate feedback mode: grade and freeze one question. */
  lockAnswer(i: number): ExamQuestionOutcome {
    const existing = this.locked.get(i);
    if (existing) return existing;
    const outcome = this.grade(i);
    this.locked.set(i, outcome);
    return outcome;
  }

  addScreenTime(i: number, ms: number): void {
    this.screenTimeMs.set(i, (this.screenTimeMs.get(i) ?? 0) + ms);
  }

  unansweredCount(): number {
    let count = 0;
    for (let i = 0; i < this.questions.length; i++) {
      if (!this.isAnswered(i)) count++;
    }
    return count;
  }

  private grade(i: number): ExamQuestionOutcome {
    const question = this.questions[i];
    const given = this.answers.get(i);

    if (question.kind === "multiple-choice") {
      const options = question.options ?? [];
      const correctIndices = options
        .map((option, index) => (option.correct ? index : -1))
        .filter((index) => index >= 0);
      const selected = given?.kind === "options" ? given.selected : [];
      return {
        index: i,
        isCorrect: selected.length > 0 && indexSetsEqual(selected, correctIndices),
        gradingMethod: "options",
        correctAnswerText: correctIndices.map((index) => options[index].text).join("\n"),
        givenAnswerText: selected.map((index) => options[index]?.text ?? "").join("\n"),
      };
    }

    const expected = question.expectedAnswer ?? "";
    const typedText = given?.kind === "typed" ? given.text : "";
    const mode = this.settings.typedGrading;
    let isCorrect: boolean;
    let gradingMethod: ExamGradingMethod;
    if (mode === "self") {
      gradingMethod = "self";
      isCorrect = given?.kind === "typed" && given.selfVerdict === true;
    } else {
      gradingMethod = mode;
      isCorrect = typedText.trim() !== "" && isTypedAnswerCorrect(typedText, expected, mode);
    }
    return {
      index: i,
      isCorrect,
      gradingMethod,
      correctAnswerText: expected,
      givenAnswerText: typedText,
    };
  }

  /** Grade everything (unanswered → incorrect) and build the persisted rows. */
  finish(): {
    session: Omit<ExamSession, "created">;
    answers: Array<Omit<ExamAnswer, "id" | "sessionId" | "created">>;
    outcomes: ExamQuestionOutcome[];
  } {
    const endedAt = this.now();
    const outcomes = this.questions.map((_q, i) => this.locked.get(i) ?? this.grade(i));
    const correctCount = outcomes.filter((o) => o.isCorrect).length;
    const questionCount = this.questions.length;
    const scorePct =
      questionCount === 0 ? 0 : Math.round((correctCount / questionCount) * 1000) / 10;

    const answers = outcomes.map((outcome, i) => ({
      flashcardId: this.questions[i].card.id,
      ordinal: i,
      questionType: this.questions[i].kind,
      gradingMethod: outcome.gradingMethod,
      prompt: truncatePrompt(this.questions[i].stem),
      correctAnswer: outcome.correctAnswerText,
      givenAnswer: outcome.givenAnswerText,
      isCorrect: outcome.isCorrect,
      timeMs: this.screenTimeMs.get(i) ?? null,
    }));

    return {
      session: {
        id: this.id,
        deckKey: this.deckKey,
        deckKind: this.deckKind,
        startedAt: this.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        configJson: JSON.stringify(this.settings),
        questionCount,
        correctCount,
        scorePct,
        passed: scorePct >= this.settings.passScorePct,
        durationMs: Math.max(0, endedAt.getTime() - this.startedAt.getTime()),
      },
      answers,
      outcomes,
    };
  }
}
