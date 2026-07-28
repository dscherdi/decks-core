import { FlashcardParser } from "../FlashcardParser";

describe("FlashcardParser.extractAndStripTags", () => {
  it("extracts plain word tags and strips them from the text", () => {
    const { cleaned, tags } = FlashcardParser.extractAndStripTags("Math basics #math #school");
    expect(cleaned).toBe("Math basics");
    expect(tags).toEqual(["math", "school"]);
  });

  it("parses tags that start with a digit (e.g. imported Anki tags)", () => {
    const { cleaned, tags } = FlashcardParser.extractAndStripTags(
      "Plan d'étude #09-courbes-en-representation-parametrique"
    );
    expect(cleaned).toBe("Plan d'étude");
    expect(tags).toEqual(["09-courbes-en-representation-parametrique"]);
  });

  it("does not treat a pure number as a tag", () => {
    const { cleaned, tags } = FlashcardParser.extractAndStripTags("Issue #123 reported");
    expect(tags).toEqual([]);
    expect(cleaned).toBe("Issue #123 reported");
  });

  it("supports nested tag paths", () => {
    const { tags } = FlashcardParser.extractAndStripTags("Topic #subject/algebra/groups");
    expect(tags).toEqual(["subject/algebra/groups"]);
  });

  it("parses tags with accented Unicode letters", () => {
    const { cleaned, tags } = FlashcardParser.extractAndStripTags("Cours #00-trigonométrie");
    expect(tags).toEqual(["00-trigonométrie"]);
    expect(cleaned).toBe("Cours");
  });
});
