import { computeCardHealth } from "../CardHealth";

const THRESHOLDS = { leechThreshold: 8, denseCardCharThreshold: 500 };
const STRING_CTX = { examEnabled: true, typedGrading: "tolerant" as const };
const SELF_CTX = { examEnabled: true, typedGrading: "self" as const };

describe("computeCardHealth exam issues", () => {
  it("returns no issue without exam context (existing callers)", () => {
    const health = computeCardHealth({ lapses: 0, back: "- [ ] A\n- [ ] B" }, THRESHOLDS);
    expect(health.examIssue).toBeNull();
  });

  it("flags invalid question bodies on header-paragraph cards", () => {
    const health = computeCardHealth(
      { lapses: 0, back: "- [ ] A\n- [ ] B", type: "header-paragraph" },
      THRESHOLDS,
      STRING_CTX
    );
    expect(health.examIssue).toEqual({
      kind: "invalid-question",
      reason: "no-correct-answer",
    });
  });

  it("flags string-ungradable answers under string modes only", () => {
    const long = { lapses: 0, back: "x".repeat(200), type: "header-paragraph" as const };
    expect(computeCardHealth(long, THRESHOLDS, STRING_CTX).examIssue).toEqual({
      kind: "answer-too-long",
    });
    expect(computeCardHealth(long, THRESHOLDS, SELF_CTX).examIssue).toBeNull();
  });

  it("grades cloze cards against the target segment", () => {
    const cloze = {
      lapses: 0,
      back: "x".repeat(200),
      type: "cloze" as const,
      clozeText: "mitochondrion",
    };
    expect(computeCardHealth(cloze, THRESHOLDS, STRING_CTX).examIssue).toBeNull();
  });

  it("leaves plain-answer cards unflagged", () => {
    const fine = {
      lapses: 0,
      back: "The mitochondrion.",
      type: "header-paragraph" as const,
    };
    expect(computeCardHealth(fine, THRESHOLDS, STRING_CTX).examIssue).toBeNull();
  });
});
