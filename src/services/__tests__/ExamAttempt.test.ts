import {
  buildExamPool,
  drawExamQuestions,
  EXAM_INERT_BLANK,
  EXAM_TARGET_BLANK,
  ExamAttempt,
} from "../ExamAttempt";
import { DEFAULT_EXAM_SETTINGS } from "../../database/types";
import type { ExamSettings, Flashcard } from "../../database/types";

const seeded = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
};

let cardCounter = 0;
function makeCard(partial: Partial<Flashcard>): Flashcard {
  cardCounter++;
  return {
    id: `card_${cardCounter}`,
    deckId: "deck_exam",
    front: `Front ${cardCounter}`,
    back: "Answer.",
    type: "header-paragraph",
    sourceFile: "test.md",
    contentHash: "hash",
    breadcrumb: "",
    notes: "",
    tags: [],
    hint: "",
    clozeText: null,
    clozeOrder: null,
    sourceNodeId: null,
    anchor: null,
    state: "new",
    dueDate: new Date().toISOString(),
    interval: 0,
    repetitions: 0,
    difficulty: 5,
    stability: 0,
    lapses: 0,
    lastReviewed: null,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    ...partial,
  } as Flashcard;
}

const EXAM_DECKS = new Map([["deck_exam", true]]);
const MCQ_BACK = "- [ ] Oxygen\n- [x] Argon\n- [ ] Nitrogen";

function mcqCard(): Flashcard {
  return makeCard({ type: "multiple-choice", back: MCQ_BACK });
}

function settings(overrides: Partial<ExamSettings> = {}): ExamSettings {
  return { ...DEFAULT_EXAM_SETTINGS, shuffleQuestions: false, shuffleOptions: false, ...overrides };
}

function attemptFor(cards: Flashcard[], overrides: Partial<ExamSettings> = {}): ExamAttempt {
  const s = settings(overrides);
  const pool = buildExamPool(cards, EXAM_DECKS, s.typedGrading);
  return new ExamAttempt({
    questions: drawExamQuestions(pool.eligible, s, seeded(1)),
    settings: s,
    deckKey: "deck_exam",
    deckKind: "file",
  });
}

describe("buildExamPool", () => {
  it("classifies eligibility per the spec table", () => {
    const cards = [
      mcqCard(),
      makeCard({ type: "header-paragraph", back: "The mitochondrion." }),
      makeCard({ type: "table", back: "Short back" }),
      makeCard({ type: "cloze", back: "The ==mitochondrion== is key.", clozeText: "mitochondrion", clozeOrder: 0 }),
      makeCard({ type: "image-occlusion" }),
      makeCard({ type: "spatial" }),
      makeCard({ deckId: "deck_plain" }),
      makeCard({ type: "header-paragraph", back: "x".repeat(200) }),
      makeCard({ type: "header-paragraph", back: "- [ ] A\n- [ ] B" }),
    ];
    const pool = buildExamPool(cards, EXAM_DECKS, "tolerant");
    expect(pool.eligible).toHaveLength(4);
    expect(pool.skipped.map((s) => s.reason).sort()).toEqual([
      "answer-too-long",
      "invalid-question",
      "not-exam-deck",
      "unsupported-type",
      "unsupported-type",
    ]);
  });

  it("waives the string ceiling under self grading", () => {
    const long = makeCard({ type: "header-paragraph", back: "x".repeat(200) });
    expect(buildExamPool([long], EXAM_DECKS, "self").eligible).toHaveLength(1);
  });

  it("blanks every cloze segment, sentinel only on the target", () => {
    const card = makeCard({
      type: "cloze",
      back: "The ==powerhouse== is the ==mitochondrion==.",
      clozeText: "mitochondrion",
      clozeOrder: 1,
    });
    const pool = buildExamPool([card], EXAM_DECKS, "tolerant");
    const context = pool.eligible[0].clozeContext!;
    expect(context).toContain(EXAM_TARGET_BLANK);
    expect(context).toContain(EXAM_INERT_BLANK);
    expect(context).not.toContain("powerhouse");
    expect(context).not.toContain("mitochondrion");
  });
});

describe("drawExamQuestions", () => {
  it("respects sequential order and the question count", () => {
    const pool = buildExamPool(
      [mcqCard(), mcqCard(), mcqCard()],
      EXAM_DECKS,
      "tolerant"
    ).eligible;
    const drawn = drawExamQuestions(pool, settings({ questionCount: 2, selectionMode: "sequential" }), seeded(2));
    expect(drawn.map((q) => q.card.id)).toEqual(pool.slice(0, 2).map((q) => q.card.id));
  });

  it("builds a display permutation when shuffleOptions is on", () => {
    const pool = buildExamPool([mcqCard()], EXAM_DECKS, "tolerant").eligible;
    const drawn = drawExamQuestions(pool, settings({ shuffleOptions: true }), seeded(3));
    expect([...drawn[0].displayOrder!].sort()).toEqual([0, 1, 2]);
    const unshuffled = drawExamQuestions(pool, settings(), seeded(3));
    expect(unshuffled[0].displayOrder).toEqual([0, 1, 2]);
  });
});

describe("ExamAttempt", () => {
  it("navigates freely and keeps answers editable until finish", () => {
    const attempt = attemptFor([mcqCard(), mcqCard()]);
    attempt.setAnswer(0, { kind: "options", selected: [0] });
    attempt.setAnswer(0, { kind: "options", selected: [1] });
    attempt.next();
    expect(attempt.currentIndex).toBe(1);
    attempt.previous();
    expect(attempt.currentIndex).toBe(0);
    attempt.goTo(99);
    expect(attempt.currentIndex).toBe(0);
    expect(attempt.isAnswered(0)).toBe(true);
    expect(attempt.unansweredCount()).toBe(1);

    const { outcomes } = attempt.finish();
    expect(outcomes[0].isCorrect).toBe(true);
  });

  it("locks an answer in immediate mode", () => {
    const attempt = attemptFor([mcqCard()]);
    attempt.setAnswer(0, { kind: "options", selected: [0] });
    const outcome = attempt.lockAnswer(0);
    expect(outcome.isCorrect).toBe(false);
    attempt.setAnswer(0, { kind: "options", selected: [1] });
    expect(attempt.finish().outcomes[0].isCorrect).toBe(false);
  });

  it("grades multi-select all-or-nothing by index set", () => {
    const card = makeCard({
      type: "multiple-choice",
      back: "- [x] Helium\n- [ ] Oxygen\n- [x] Argon",
    });
    const attempt = attemptFor([card]);
    attempt.setAnswer(0, { kind: "options", selected: [0] });
    expect(attempt.finish().outcomes[0].isCorrect).toBe(false);

    const attempt2 = attemptFor([card]);
    attempt2.setAnswer(0, { kind: "options", selected: [2, 0] });
    expect(attempt2.finish().outcomes[0].isCorrect).toBe(true);
  });

  it("grades typed answers per mode, and self-verdicts under self", () => {
    const card = makeCard({ type: "header-paragraph", back: "Mitochondrion" });
    const tolerant = attemptFor([card], { typedGrading: "tolerant" });
    tolerant.setAnswer(0, { kind: "typed", text: "mitochondrian", selfVerdict: null });
    expect(tolerant.finish().outcomes[0].isCorrect).toBe(true);

    const selfMode = attemptFor([card], { typedGrading: "self" });
    selfMode.setAnswer(0, { kind: "typed", text: "my own words", selfVerdict: null });
    selfMode.setSelfVerdict(0, true);
    const finished = selfMode.finish();
    expect(finished.outcomes[0].isCorrect).toBe(true);
    expect(finished.answers[0].gradingMethod).toBe("self");
  });

  it("finish() grades unanswered as incorrect with empty given answers", () => {
    const attempt = attemptFor([mcqCard(), mcqCard()]);
    attempt.setAnswer(0, { kind: "options", selected: [1] });
    attempt.addScreenTime(0, 4000);
    attempt.addScreenTime(0, 2000);

    const { session, answers } = attempt.finish();
    expect(session.questionCount).toBe(2);
    expect(session.correctCount).toBe(1);
    expect(session.scorePct).toBe(50);
    expect(session.passed).toBe(false);
    expect(answers[0].timeMs).toBe(6000);
    expect(answers[1].givenAnswer).toBe("");
    expect(answers[1].isCorrect).toBe(false);
    expect(answers.map((a) => a.ordinal)).toEqual([0, 1]);
  });

  it("truncates the prompt snapshot", () => {
    const card = makeCard({
      type: "header-paragraph",
      front: "Q ".repeat(300),
      back: "Short.",
    });
    const attempt = attemptFor([card]);
    const { answers } = attempt.finish();
    expect(answers[0].prompt.length).toBeLessThanOrEqual(200);
  });
});
