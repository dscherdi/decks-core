import initSqlJs from "sql.js";
import { computeCardHealth, isCardDense } from "../CardHealth";
import { compileFilter } from "../FilterEngine";
import { evaluateFilter } from "../FilterEvaluator";
import type { Flashcard, FilterDefinition, FlashcardType } from "../../database/types";

const THRESHOLDS = { leechThreshold: 8, denseCardCharThreshold: 500 };
const LONG = "x".repeat(600);
const DENSE_ONLY: FilterDefinition = {
  version: 1,
  logic: "AND",
  rules: [{ field: "isDense", operator: "equals", value: "true" }],
};
const NOT_DENSE: FilterDefinition = {
  version: 1,
  logic: "AND",
  rules: [{ field: "isDense", operator: "equals", value: "false" }],
};

function card(type: FlashcardType, back: string): Flashcard {
  return {
    id: `card_${type}`,
    deckId: "deck_1",
    front: "Front",
    back,
    type,
    sourceFile: "Note.md",
    contentHash: "",
    breadcrumb: "",
    notes: "",
    tags: [],
    hint: "",
    clozeText: null,
    clozeOrder: null,
    state: "new",
    dueDate: "2026-10-23T00:00:00.000Z",
    interval: 0,
    repetitions: 0,
    difficulty: 5,
    stability: 0,
    lapses: 0,
    lastReviewed: null,
    suspendedAt: null,
    buriedUntil: null,
    created: "2026-10-23T00:00:00.000Z",
    modified: "2026-10-23T00:00:00.000Z",
  };
}

describe("card density", () => {
  it("flags long prose answers", () => {
    expect(computeCardHealth({ lapses: 0, back: LONG, type: "header-paragraph" }, THRESHOLDS).isDense).toBe(true);
    expect(computeCardHealth({ lapses: 0, back: LONG }, THRESHOLDS).isDense).toBe(true);
    expect(isCardDense({ back: LONG, type: "cloze" }, 500)).toBe(true);
  });

  it("never flags occlusion v2 or exam cards, whose back holds data", () => {
    for (const type of ["image-occlusion-v2", "multiple-choice"] as const) {
      expect(computeCardHealth({ lapses: 0, back: LONG, type }, THRESHOLDS).isDense).toBe(false);
      expect(evaluateFilter(card(type, LONG), DENSE_ONLY, {})).toBe(false);
      expect(evaluateFilter(card(type, LONG), NOT_DENSE, {})).toBe(true);
    }
    expect(evaluateFilter(card("header-paragraph", LONG), DENSE_ONLY, {})).toBe(true);
  });

  it("applies the same rule in the compiled SQL filter", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE flashcards (id TEXT, type TEXT, back TEXT)");
    const rows: [string, FlashcardType, string][] = [
      ["prose", "header-paragraph", LONG],
      ["short", "header-paragraph", "short"],
      ["occlusion", "image-occlusion-v2", LONG],
      ["exercise", "multiple-choice", LONG],
    ];
    for (const row of rows) db.run("INSERT INTO flashcards VALUES (?, ?, ?)", row);

    const ids = (def: FilterDefinition): string[] => {
      const { whereClause, params } = compileFilter(def);
      const result = db.exec(`SELECT f.id FROM flashcards f WHERE ${whereClause} ORDER BY f.id`, params);
      return (result[0]?.values ?? []).map((value) => String(value[0]));
    };
    expect(ids(DENSE_ONLY)).toEqual(["prose"]);
    expect(ids(NOT_DENSE)).toEqual(["exercise", "occlusion", "short"]);
    db.close();
  });
});
