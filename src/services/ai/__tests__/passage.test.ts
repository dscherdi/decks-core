import { MAX_PASSAGE_CHARS, MIN_PASSAGE_CHARS, passageFrom, passageSource } from "../passage";
import { pageMarker } from "../../pdf/pdf";

describe("passageFrom", () => {
  const passage = "The variance is the mean squared deviation.";

  it("reads the page from the attribute the viewer carries", () => {
    expect(passageFrom(passage, "70")).toEqual({ text: passage, page: 70 });
  });

  it("collapses the whitespace a text layer introduces", () => {
    expect(passageFrom("The  variance\nis  measured.", "70")?.text).toBe("The variance is measured.");
  });

  it("keeps the passage when no page can be read, rather than guessing one", () => {
    expect(passageFrom(passage, null)).toEqual({ text: passage, page: null });
    expect(passageFrom(passage, "not-a-page")?.page).toBeNull();
    expect(passageFrom(passage, "0")?.page).toBeNull();
  });

  it("ignores a selection too short to be a passage", () => {
    expect(passageFrom("var", "70")).toBeNull();
    expect(passageFrom("   \n  ", "70")).toBeNull();
    expect(passageFrom("x".repeat(MIN_PASSAGE_CHARS - 1), "70")).toBeNull();
    expect(passageFrom("x".repeat(MIN_PASSAGE_CHARS), "70")).not.toBeNull();
  });

  it("caps a whole-chapter drag", () => {
    expect(passageFrom("x".repeat(MAX_PASSAGE_CHARS + 500), "70")?.text).toHaveLength(MAX_PASSAGE_CHARS);
  });
});

describe("passageSource", () => {
  it("labels the passage with its page so cards can cite it", () => {
    expect(passageSource({ text: "Median", page: 4 })).toBe(`${pageMarker(4)}\nMedian`);
  });

  it("sends the text alone when the page is unknown", () => {
    expect(passageSource({ text: "Median", page: null })).toBe("Median");
  });
});
