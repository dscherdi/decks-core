import {
  buildExamPool,
  drawExamQuestions,
  ExamAttempt,
  examUnits,
  groupExamExercises,
  sampleExamUnits,
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

let counter = 0;
function card(partial: Partial<Flashcard>): Flashcard {
  counter++;
  return {
    id: `card_${counter}`,
    deckId: "deck_exam",
    front: `Front ${counter}`,
    back: "- [x] A\n- [ ] B",
    type: "multiple-choice",
    sourceFile: "test.md",
    contentHash: "hash",
    breadcrumb: "",
    notes: "",
    tags: [],
    hint: "",
    clozeText: null,
    clozeOrder: null,
    state: "new",
    dueDate: "",
    interval: 0,
    repetitions: 0,
    difficulty: 5,
    stability: 0,
    lapses: 0,
    lastReviewed: null,
    suspendedAt: null,
    buriedUntil: null,
    created: "",
    modified: "",
    ...partial,
  };
}

const EXAM_DECKS = new Map([["deck_exam", true]]);
const settings = (overrides: Partial<ExamSettings> = {}): ExamSettings => ({
  ...DEFAULT_EXAM_SETTINGS,
  shuffleQuestions: false,
  shuffleOptions: false,
  ...overrides,
});

const EXERCISE_BACK = [
  "Bei Stefan Berger gibt es Gerichte.",
  "",
  "Die Gäste …",
  "- [ ] finden immer einen Tisch.",
  "- [x] sollen reservieren.",
  "%%Second paragraph.%%",
  "",
  "Stefan Berger möchte …",
  "- [x] ein Restaurant haben.",
  "- [ ] eröffnen.",
  "",
  "Er kocht …",
  "- [x] gern.",
  "- [ ] nie.",
].join("\n");

describe("exam exercises", () => {
  it("asks each checklist of an exercise card as its own question", () => {
    const exercise = card({ back: EXERCISE_BACK, notes: "Source: Goethe" });
    const pool = buildExamPool([exercise], EXAM_DECKS, "tolerant").eligible;
    expect(pool.map((q) => q.key)).toEqual([`${exercise.id}#0`, `${exercise.id}#1`, `${exercise.id}#2`]);
    expect(pool.map((q) => q.stem)).toEqual(["Die Gäste …", "Stefan Berger möchte …", "Er kocht …"]);
    expect(pool[0].notes).toBe("Second paragraph.");
    expect(pool[2].notes).toBe("Source: Goethe");
    expect(pool[0].material).toEqual({
      key: `card:${exercise.id}`,
      heading: exercise.front,
      body: "Bei Stefan Berger gibt es Gerichte.",
    });
    expect(new Set(pool.map((q) => q.exerciseKey)).size).toBe(1);
  });

  it("draws whole exercises and may run over the count by part of one", () => {
    const cards = [card({ back: EXERCISE_BACK }), card({}), card({})];
    const pool = buildExamPool(cards, EXAM_DECKS, "tolerant").eligible;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const drawn = drawExamQuestions(pool, settings({ questionCount: 2, selectionMode: "random" }), seeded(seed));
      const fromExercise = drawn.filter((q) => q.card.id === cards[0].id).length;
      expect([0, 3]).toContain(fromExercise);
      expect(drawn.length).toBeGreaterThanOrEqual(2);
      expect(drawn.length).toBeLessThanOrEqual(4);
    }
  });

  it("takes exercises in order when sequential", () => {
    const cards = [card({}), card({ back: EXERCISE_BACK }), card({})];
    const pool = buildExamPool(cards, EXAM_DECKS, "tolerant").eligible;
    const drawn = drawExamQuestions(pool, settings({ questionCount: 2, selectionMode: "sequential" }), seeded(1));
    expect(drawn.map((q) => q.key)).toEqual([cards[0].id, `${cards[1].id}#0`, `${cards[1].id}#1`, `${cards[1].id}#2`]);
  });

  it("shuffles exercises but never the questions inside one", () => {
    const cards = [card({ back: EXERCISE_BACK }), card({}), card({}), card({})];
    const pool = buildExamPool(cards, EXAM_DECKS, "tolerant").eligible;
    for (const seed of [1, 2, 3, 4, 5]) {
      const drawn = drawExamQuestions(pool, settings({ shuffleQuestions: true }), seeded(seed));
      const at = drawn.findIndex((q) => q.card.id === cards[0].id);
      expect(drawn.slice(at, at + 3).map((q) => q.key)).toEqual([0, 1, 2].map((i) => `${cards[0].id}#${i}`));
    }
  });

  it("samples whole units up to a limit", () => {
    const pool = buildExamPool([card({ back: EXERCISE_BACK }), card({}), card({})], EXAM_DECKS, "tolerant").eligible;
    const units = examUnits(pool);
    const picked = sampleExamUnits(units, 1, true, seeded(3));
    expect(picked).toHaveLength(1);
    expect(sampleExamUnits(units, 10, true, seeded(3))).toEqual(units);
  });

  it("scores and records each sub-question on its own", () => {
    const exercise = card({ back: EXERCISE_BACK });
    const s = settings();
    const questions = drawExamQuestions(buildExamPool([exercise], EXAM_DECKS, "tolerant").eligible, s, seeded(1));
    const attempt = new ExamAttempt({ questions, settings: s, deckKey: "deck_exam", deckKind: "file" });
    attempt.setAnswer(0, { kind: "options", selected: [1] });
    attempt.setAnswer(1, { kind: "options", selected: [1] });
    const result = attempt.finish();
    expect(result.session.questionCount).toBe(3);
    expect(result.session.correctCount).toBe(1);
    expect(result.answers.map((a) => [a.flashcardId, a.ordinal, a.prompt])).toEqual([
      [exercise.id, 0, "Die Gäste …"],
      [exercise.id, 1, "Stefan Berger möchte …"],
      [exercise.id, 2, "Er kocht …"],
    ]);
  });

  it("groups an attempt's questions for the screens", () => {
    const exercise = card({ back: EXERCISE_BACK });
    const lone = card({});
    const questions = drawExamQuestions(buildExamPool([lone, exercise], EXAM_DECKS, "tolerant").eligible, settings(), seeded(1));
    const exercises = groupExamExercises(questions);
    expect(exercises.map((e) => e.indices)).toEqual([[0], [1, 2, 3]]);
    expect(exercises[0].material).toBeNull();
    expect(exercises[1].material?.heading).toBe(exercise.front);
  });

  it("asks typed answers and each blank as questions of the exercise", () => {
    const back = ["Text", "### Preis?", "12 Euro", "### Ergänze", "Um ==8== Uhr, Gleis ==3==.", "### Wann?", "- [x] früh", "- [ ] spät"].join("\n");
    const exercise = card({ back });
    const pool = buildExamPool([exercise], EXAM_DECKS, "tolerant").eligible;
    expect(pool.map((q) => [q.kind, q.stem, q.expectedAnswer, q.isCloze])).toEqual([
      ["type-in", "Preis?", "12 Euro", false],
      ["type-in", "Ergänze", "8", true],
      ["type-in", "Ergänze", "3", true],
      ["multiple-choice", "Wann?", null, false],
    ]);
    expect(pool[1].clozeContext).toContain("⟦DECKS-EXAM-BLANK⟧");
    expect(pool[1].clozeContext).not.toContain("3");
    expect(new Set(pool.map((q) => q.key)).size).toBe(4);
  });

  it("leaves out a typed answer too long to check by text, keeping the rest", () => {
    const back = ["### Erkläre", "x ".repeat(200), "### Wann?", "- [x] früh", "- [ ] spät"].join("\n");
    const built = buildExamPool([card({ back })], EXAM_DECKS, "tolerant");
    expect(built.eligible.map((q) => q.stem)).toEqual(["Wann?"]);
    expect(built.skipped.map((s) => s.reason)).toEqual(["answer-too-long"]);
    expect(buildExamPool([card({ back })], EXAM_DECKS, "self").eligible).toHaveLength(2);
  });
});
