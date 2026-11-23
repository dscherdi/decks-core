import initSqlJs from "sql.js";
import { cardMastery, isCardMature, masteryOfStability, masterySql, maturityLevelOf, MATURE_STABILITY_DAYS } from "../types";

describe("maturity levels", () => {
  const card = (state: "new" | "review", stability: number) => ({ state, stability });

  it("places each stability in its level", () => {
    expect(maturityLevelOf(card("new", 400))).toBe("new");
    expect(maturityLevelOf(card("review", 0.4))).toBe("learning");
    expect(maturityLevelOf(card("review", 1))).toBe("young");
    expect(maturityLevelOf(card("review", 20.9))).toBe("young");
    expect(maturityLevelOf(card("review", 21))).toBe("mature");
    expect(maturityLevelOf(card("review", 89.9))).toBe("mature");
    expect(maturityLevelOf(card("review", 90))).toBe("strong");
    expect(maturityLevelOf(card("review", 364))).toBe("strong");
    expect(maturityLevelOf(card("review", 365))).toBe("mastered");
  });

  it("counts a card as mature from 21 days of stability, whatever its interval", () => {
    expect(isCardMature(card("review", MATURE_STABILITY_DAYS))).toBe(true);
    expect(isCardMature(card("review", MATURE_STABILITY_DAYS - 0.1))).toBe(false);
    expect(isCardMature(card("new", 200))).toBe(false);
  });

  it("agrees with the level for every reviewed card", () => {
    for (const s of [0.1, 3, 20.99, 21, 50, 120, 800]) {
      const level = maturityLevelOf(card("review", s));
      expect(isCardMature(card("review", s))).toBe(["mature", "strong", "mastered"].includes(level));
    }
  });
});

describe("mastery score", () => {
  const exact = (days: number) => Math.log1p(days) / Math.log1p(365);

  it("is log(1 + stability) over log(1 + a year) at its fixed points", () => {
    for (const days of [1, 7, 21, 90, 180]) expect(masteryOfStability(days)).toBeCloseTo(exact(days), 10);
    expect(masteryOfStability(21)).toBeCloseTo(0.524, 3);
    expect(masteryOfStability(90)).toBeCloseTo(0.764, 3);
  });

  it("stays within half a point of the log curve between them", () => {
    for (let days = 0.05; days < 365; days *= 1.07) {
      expect(Math.abs(masteryOfStability(days) - exact(days))).toBeLessThan(0.005);
    }
  });

  it("rises with stability from 0 to 1 and stops at a year", () => {
    let last = 0;
    for (let days = 0; days <= 400; days += 0.25) {
      const value = masteryOfStability(days);
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
    expect(masteryOfStability(365)).toBe(1);
    expect(masteryOfStability(2000)).toBe(1);
    expect(masteryOfStability(0)).toBe(0);
    expect(masteryOfStability(-3)).toBe(0);
    expect(masteryOfStability(Number.NaN)).toBe(0);
  });

  it("gives a new card nothing, whatever its stability", () => {
    expect(cardMastery({ state: "new", stability: 400 })).toBe(0);
    expect(cardMastery({ state: "review", stability: 400 })).toBe(1);
  });

  it("computes the same values in SQL", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE cards (stability REAL)");
    const samples = [null, -1, 0, 0.3, 0.5, 1, 1.7, 6.5, 21, 33.3, 89.9, 90, 200, 364.9, 365, 900];
    for (const s of samples) db.run("INSERT INTO cards VALUES (?)", [s]);
    const rows = db.exec(`SELECT stability, ${masterySql("stability")} FROM cards`)[0].values;
    for (const [stability, value] of rows) {
      expect(value as number).toBeCloseTo(masteryOfStability((stability as number | null) ?? 0), 12);
    }
    db.close();
  });
});
