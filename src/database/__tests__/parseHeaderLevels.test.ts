import { parseHeaderLevels } from "../types";

describe("parseHeaderLevels", () => {
  it("returns [0] for title mode, ignoring extras", () => {
    expect(parseHeaderLevels({ headerLevel: 0, extraHeaderLevels: [3, 4] })).toEqual([0]);
  });

  it("combines the primary level with valid extras", () => {
    expect(parseHeaderLevels({ headerLevel: 2, extraHeaderLevels: [3, 4] })).toEqual([2, 3, 4]);
  });

  it("dedupes the primary level if it also appears in extras", () => {
    expect(parseHeaderLevels({ headerLevel: 2, extraHeaderLevels: [2, 3] })).toEqual([2, 3]);
  });

  it("filters out-of-range extras (must be 1-6)", () => {
    expect(parseHeaderLevels({ headerLevel: 2, extraHeaderLevels: [0, 7, 3] })).toEqual([2, 3]);
  });

  it("defaults to just the primary level when extras are missing", () => {
    expect(parseHeaderLevels({ headerLevel: 2 })).toEqual([2]);
    expect(parseHeaderLevels({ headerLevel: 2, extraHeaderLevels: [] })).toEqual([2]);
  });
});
