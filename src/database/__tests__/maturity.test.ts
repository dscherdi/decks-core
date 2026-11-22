import { isCardMature, maturityLevelOf, MATURE_STABILITY_DAYS } from "../types";

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
