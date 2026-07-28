import { DEFAULT_EXAM_SETTINGS, parseExamSettings } from "../types";

describe("parseExamSettings", () => {
  it("returns defaults for null, empty and malformed input", () => {
    expect(parseExamSettings(null)).toEqual(DEFAULT_EXAM_SETTINGS);
    expect(parseExamSettings(undefined)).toEqual(DEFAULT_EXAM_SETTINGS);
    expect(parseExamSettings("")).toEqual(DEFAULT_EXAM_SETTINGS);
    expect(parseExamSettings("{not json")).toEqual(DEFAULT_EXAM_SETTINGS);
    expect(parseExamSettings("[1,2]")).toEqual({ ...DEFAULT_EXAM_SETTINGS });
  });

  it("merges partial objects onto defaults", () => {
    const parsed = parseExamSettings('{"passScorePct": 80, "shuffleQuestions": false}');
    expect(parsed.passScorePct).toBe(80);
    expect(parsed.shuffleQuestions).toBe(false);
    expect(parsed.typedGrading).toBe("tolerant");
  });

  it("rejects invalid field values per-field", () => {
    const parsed = parseExamSettings(
      '{"passScorePct": -5, "typedGrading": "ai", "optionLabels": "numbers"}'
    );
    expect(parsed.passScorePct).toBe(DEFAULT_EXAM_SETTINGS.passScorePct);
    expect(parsed.typedGrading).toBe("tolerant");
    expect(parsed.optionLabels).toBe("numbers");
  });

  it("round-trips a full settings object", () => {
    const full = { ...DEFAULT_EXAM_SETTINGS, questionCount: 30, timeLimitMinutes: 20 };
    expect(parseExamSettings(JSON.stringify(full))).toEqual(full);
  });
});
