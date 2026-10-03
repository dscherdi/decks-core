import { REPAIR_LAPSE_THRESHOLD, wantsRepair } from "../repair";

describe("wantsRepair", () => {
  it("stays quiet through ordinary forgetting", () => {
    for (let lapses = 0; lapses < REPAIR_LAPSE_THRESHOLD; lapses++) {
      expect(wantsRepair(lapses, true)).toBe(false);
    }
  });

  it("offers once a card has been missed enough to be the suspect", () => {
    expect(wantsRepair(REPAIR_LAPSE_THRESHOLD, true)).toBe(true);
    expect(wantsRepair(REPAIR_LAPSE_THRESHOLD + 9, true)).toBe(true);
  });

  it("offers nothing without a source — there would be no page to re-read", () => {
    expect(wantsRepair(99, false)).toBe(false);
  });

  it("treats a missing lapse count as no reason to intervene", () => {
    expect(wantsRepair(Number.NaN, true)).toBe(false);
  });

  it("takes the host's own threshold when it has one", () => {
    // The leech threshold is the same question asked once; a card is not the
    // suspect at three if the reader said eight.
    expect(wantsRepair(3, true, 8)).toBe(false);
    expect(wantsRepair(8, true, 8)).toBe(true);
    expect(wantsRepair(2, true, 1)).toBe(true);
  });

  it("offers nothing when the threshold itself is not a number", () => {
    expect(wantsRepair(99, true, Number.NaN)).toBe(false);
  });
});
