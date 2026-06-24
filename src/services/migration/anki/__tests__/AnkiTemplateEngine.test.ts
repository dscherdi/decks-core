import { AnkiTemplateEngine } from "../AnkiTemplateEngine";

describe("AnkiTemplateEngine", () => {
  it("substitutes fields and expands {{FrontSide}} with an answer split", () => {
    const result = AnkiTemplateEngine.render(
      "{{Front}}",
      "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
      { Front: "Q", Back: "A" }
    );
    expect(result.frontHtml).toBe("Q");
    expect(result.backHtml).toContain("Q");
    expect(result.backHtml).toContain("A");
    expect(result.answerHtml).toBe("A"); // everything after <hr id=answer>
    expect(result.usedFields.sort()).toEqual(["Back", "Front"]);
    expect(result.extraFields).toEqual([]);
  });

  it("renders the reverse template independently", () => {
    const result = AnkiTemplateEngine.render("{{Back}}", "{{FrontSide}}<hr id=answer>{{Front}}", {
      Front: "Q",
      Back: "A",
    });
    expect(result.frontHtml).toBe("A");
    expect(result.answerHtml).toBe("Q");
  });

  it("keeps a positive section only when the field is non-empty", () => {
    const tmpl = "{{Front}}{{#Image}}<img src=\"{{Image}}\">{{/Image}}";
    const withImage = AnkiTemplateEngine.render(tmpl, "{{FrontSide}}", { Front: "Q", Image: "p.jpg" });
    expect(withImage.frontHtml).toBe('Q<img src="p.jpg">');
    const withoutImage = AnkiTemplateEngine.render(tmpl, "{{FrontSide}}", { Front: "Q", Image: "" });
    expect(withoutImage.frontHtml).toBe("Q");
    // Image is referenced by the template, so it is never an extra field.
    expect(withImage.usedFields).toContain("Image");
  });

  it("keeps a negative section only when the field is empty", () => {
    const tmpl = "{{^Extra}}no extra{{/Extra}}{{#Extra}}{{Extra}}{{/Extra}}";
    expect(AnkiTemplateEngine.render(tmpl, "", { Extra: "" }).frontHtml).toBe("no extra");
    expect(AnkiTemplateEngine.render(tmpl, "", { Extra: "hi" }).frontHtml).toBe("hi");
  });

  it("resolves nested sections", () => {
    const tmpl = "{{#A}}A{{#B}}B{{/B}}{{/A}}";
    expect(AnkiTemplateEngine.render(tmpl, "", { A: "x", B: "y" }).frontHtml).toBe("AB");
    expect(AnkiTemplateEngine.render(tmpl, "", { A: "x", B: "" }).frontHtml).toBe("A");
    expect(AnkiTemplateEngine.render(tmpl, "", { A: "", B: "y" }).frontHtml).toBe("");
  });

  it("resolves field modifiers via the underlying field", () => {
    const result = AnkiTemplateEngine.render("{{hint:Note}}", "{{FrontSide}}", { Note: "tip" });
    expect(result.frontHtml).toBe("tip");
    expect(result.usedFields).toContain("Note");
  });

  it("replaces unknown fields with an empty string", () => {
    const result = AnkiTemplateEngine.render("{{Front}}{{Missing}}", "{{FrontSide}}", { Front: "Q" });
    expect(result.frontHtml).toBe("Q");
  });

  it("collects unused non-empty fields into the extra table, dropping empties", () => {
    const result = AnkiTemplateEngine.render("{{Front}}", "{{FrontSide}}<hr id=answer>{{Back}}", {
      Front: "Q",
      Back: "A",
      Source: "Book p.5",
      Empty: "   ",
    });
    expect(result.extraFields).toEqual([{ name: "Source", value: "Book p.5" }]);
    expect(result.extraFieldsTable).toBe(
      "| Extra Fields | Content |\n| :--- | :--- |\n| **Source** | Book p.5 |"
    );
  });

  it("returns the whole back when there is no <hr id=answer>", () => {
    const result = AnkiTemplateEngine.render("{{cloze:Text}}", "{{cloze:Text}}<br>{{Extra}}", {
      Text: "x {{c1::y}}",
      Extra: "note",
    });
    expect(result.answerHtml).toBe(result.backHtml);
  });
});
