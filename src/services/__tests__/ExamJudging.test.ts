import { buildExamPool, drawExamQuestions, ExamAttempt } from "../ExamAttempt";
import { judgePending, type ExamJudge } from "../ExamJudging";
import { localMeaningVerdict, numericAnswerVerdict, MAX_MEANING_ANSWER_LENGTH } from "../ExamGrading";
import { DEFAULT_EXAM_SETTINGS, parseExamSettings } from "../../database/types";
import type { ExamSettings, Flashcard } from "../../database/types";
import { AiGradingService } from "../ai/AiGradingService";
import { parseGradeVerdicts } from "../ai/grading";
import type { HttpClient } from "../ai/HttpClient";

let n = 0;
function card(partial: Partial<Flashcard>): Flashcard {
  n++;
  return {
    id: `card_${n}`,
    deckId: "deck_exam",
    front: `Question ${n}?`,
    back: "Answer.",
    type: "header-paragraph",
    sourceFile: "t.md",
    contentHash: "h",
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

function attemptFor(cards: Flashcard[], overrides: Partial<ExamSettings> = {}): ExamAttempt {
  const s = { ...DEFAULT_EXAM_SETTINGS, shuffleQuestions: false, selectionMode: "sequential" as const, typedGrading: "meaning" as const, ...overrides };
  const pool = buildExamPool(cards, new Map([["deck_exam", true]]), s.typedGrading);
  return new ExamAttempt({
    questions: drawExamQuestions(pool.eligible, s),
    settings: s,
    deckKey: "deck_exam",
    deckKind: "file",
  });
}

const typed = (text: string) => ({ kind: "typed" as const, text, selfVerdict: null });

describe("meaning grading settings", () => {
  it("parses the mode and allows longer answers", () => {
    expect(parseExamSettings('{"typedGrading":"meaning"}').typedGrading).toBe("meaning");
    const long = "x".repeat(300);
    const tolerant = buildExamPool([card({ back: long })], new Map([["deck_exam", true]]), "tolerant");
    const meaning = buildExamPool([card({ back: long })], new Map([["deck_exam", true]]), "meaning");
    expect(tolerant.eligible).toHaveLength(0);
    expect(meaning.eligible).toHaveLength(1);
    const tooLong = buildExamPool(
      [card({ back: "y".repeat(MAX_MEANING_ANSWER_LENGTH + 1) })],
      new Map([["deck_exam", true]]),
      "meaning"
    );
    expect(tooLong.skipped[0]?.reason).toBe("answer-too-long");
  });
});

describe("numericAnswerVerdict", () => {
  it("settles values and leaves the rest", () => {
    expect(numericAnswerVerdict("3,5 m/s", "3.5 m/s")).toBe(true);
    expect(numericAnswerVerdict("1067", "1066")).toBe(false);
    expect(numericAnswerVerdict("3.5 km", "3.5 m")).toBeNull();
    expect(numericAnswerVerdict("the Normans", "1066")).toBeNull();
    expect(numericAnswerVerdict("1066", "The battle was fought in 1066 near Hastings")).toBeNull();
  });
});

describe("localMeaningVerdict", () => {
  it("settles only what is certain and leaves wrong-looking answers to the backend", () => {
    expect(localMeaningVerdict("", "Paris")).toEqual({ correct: false, method: "meaning" });
    expect(localMeaningVerdict("paris!", "Paris")).toEqual({ correct: true, method: "exact" });
    expect(localMeaningVerdict("mitochondrion", "The mitochondrion")).toEqual({ correct: true, method: "exact" });
    expect(localMeaningVerdict("ilium", "ileum")).toBeNull();
    expect(localMeaningVerdict("Mass is not conserved", "Mass is conserved")).toBeNull();
    expect(localMeaningVerdict("が", "か")).toBeNull();
    expect(localMeaningVerdict("1066", "1066 AD")).toEqual({ correct: true, method: "numeric" });
    expect(localMeaningVerdict("1067", "1066")).toBeNull();
    expect(localMeaningVerdict("It ended in 1944", "It ended in 1945")).toBeNull();
    expect(localMeaningVerdict("Lyon", "Paris")).toBeNull();
  });

  it("compares code as written", () => {
    expect(localMeaningVerdict("xs . length", "xs.length")).toEqual({ correct: true, method: "exact" });
    expect(localMeaningVerdict("xs.length()", "xs.length")).toBeNull();
  });
});

describe("ExamAttempt under meaning grading", () => {
  it("settles empty, close and numeric answers locally and asks about the rest", () => {
    const attempt = attemptFor([
      card({ back: "The mitochondrion" }),
      card({ back: "1066 AD" }),
      card({ back: "Photosynthesis" }),
      card({ back: "Osmosis" }),
    ]);
    attempt.setAnswer(0, typed("mitochondrion"));
    attempt.setAnswer(1, typed("1066"));
    attempt.setAnswer(2, typed("plants turning light into sugar"));
    attempt.setAnswer(3, typed(""));

    const pending = attempt.pendingJudgements();
    expect(pending.map((p) => p.id)).toEqual(["2"]);
    expect(pending[0]).toMatchObject({ expected: "Photosynthesis", given: "plants turning light into sugar" });

    const { outcomes } = attempt.finish();
    expect(outcomes.map((o) => [o.isCorrect, o.gradingMethod])).toEqual([
      [true, "exact"],
      [true, "numeric"],
      [false, "meaning"],
      [false, "meaning"],
    ]);
  });

  it("binds a judgement to the text it judged", () => {
    const attempt = attemptFor([card({ back: "Photosynthesis" })]);
    attempt.setAnswer(0, typed("light to sugar"));
    attempt.applyJudgement(0, "light to sugar", true);
    expect(attempt.needsSelfVerdict(0)).toBe(false);
    expect(attempt.finish().outcomes[0]).toMatchObject({ isCorrect: true, gradingMethod: "meaning" });

    attempt.setAnswer(0, typed("respiration"));
    expect(attempt.pendingJudgements().map((p) => p.id)).toEqual(["0"]);
    attempt.applyJudgement(0, "light to sugar", true);
    expect(attempt.needsSelfVerdict(0)).toBe(true);
  });

  it("falls back to the student's own verdict", () => {
    const attempt = attemptFor([card({ back: "Photosynthesis" })]);
    attempt.setAnswer(0, typed("light to sugar"));
    attempt.setSelfVerdict(0, true);
    expect(attempt.pendingJudgements()).toEqual([]);
    expect(attempt.finish().outcomes[0]).toMatchObject({ isCorrect: true, gradingMethod: "self" });
  });

  it("sends the cloze sentence with the target marked and the rest of the back as context", () => {
    const cloze = card({ type: "cloze", back: "The ==mitochondrion== makes ==ATP==.", clozeText: "mitochondrion", clozeOrder: 0 });
    const plain = card({ back: "Photosynthesis\n\nPlants turn **light** into sugar." });
    const attempt = attemptFor([cloze, plain]);
    attempt.setAnswer(0, typed("powerhouse"));
    attempt.setAnswer(1, typed("making food from light"));
    const [c, p] = attempt.pendingJudgements();
    expect(c.prompt).toContain("The [____] makes ____.");
    expect(c.context).toBeUndefined();
    expect(p.context).toBe("Plants turn light into sugar.");
  });

  it("asks for nothing under other modes", () => {
    const attempt = attemptFor([card({ back: "Photosynthesis" })], { typedGrading: "tolerant" });
    attempt.setAnswer(0, typed("light to sugar"));
    expect(attempt.pendingJudgements()).toEqual([]);
    expect(attempt.needsSelfVerdict(0)).toBe(false);
  });
});

describe("judgePending", () => {
  const cards = () => [card({ back: "Photosynthesis" }), card({ back: "Osmosis" }), card({ back: "Diffusion" })];

  it("applies verdicts and returns what stays unsure", async () => {
    const attempt = attemptFor(cards());
    attempt.setAnswer(0, typed("light to sugar"));
    attempt.setAnswer(1, typed("water through a membrane"));
    attempt.setAnswer(2, typed("spreading out"));
    const judge: ExamJudge = async () =>
      new Map([
        ["0", "correct"],
        ["1", "unsure"],
        ["2", "incorrect"],
      ]);
    expect(await judgePending(attempt, judge)).toEqual({ unresolved: [1], failed: false });
    expect(attempt.finish().outcomes.map((o) => o.isCorrect)).toEqual([true, false, false]);
  });

  it("hands everything to the student when there is no judge or it fails", async () => {
    const attempt = attemptFor(cards());
    attempt.setAnswer(0, typed("light to sugar"));
    attempt.setAnswer(2, typed("spreading out"));
    expect(await judgePending(attempt, null)).toEqual({ unresolved: [0, 2], failed: true });
    const failing: ExamJudge = async () => {
      throw new Error("offline");
    };
    expect(await judgePending(attempt, failing, [2])).toEqual({ unresolved: [2], failed: true });
  });
});

describe("AiGradingService", () => {
  const items = [{ id: "0", prompt: "Q?", expected: "A", given: "a" }];

  it("posts the answers under the grading sentinel and keeps only asked ids", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const http: HttpClient = {
      request: async (req) => {
        sent.push(JSON.parse(String(req.body)) as Record<string, unknown>);
        const content = JSON.stringify({ verdicts: [{ id: "0", verdict: "correct" }, { id: "9", verdict: "correct" }] });
        return { status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }), headers: {} };
      },
    } as HttpClient;
    const out = await new AiGradingService(http).grade({ provider: "decks-pro", model: "decks-tier-fast", apiKey: "dk_x" }, items);
    expect([...out]).toEqual([["0", "correct"]]);
    expect(sent[0]).toEqual({ model: "decks-grade", grade: { items } });
  });

  it("does nothing for other providers", async () => {
    const http = { request: jest.fn() } as unknown as HttpClient;
    const out = await new AiGradingService(http).grade({ provider: "openai", model: "x", apiKey: "k" }, items);
    expect(out.size).toBe(0);
    expect(http.request).not.toHaveBeenCalled();
  });

  it("parses only well-formed verdicts", () => {
    expect([...parseGradeVerdicts('{"verdicts":[{"id":"1","verdict":"unsure"},{"id":2,"verdict":"correct"},{"id":"3","verdict":"maybe"}]}')]).toEqual([["1", "unsure"]]);
    expect(parseGradeVerdicts("nope").size).toBe(0);
  });
});
