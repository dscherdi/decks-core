import { AnkiTemplateExporter } from "../AnkiTemplateExporter";
import type { AnkiModel } from "../AnkiTypes";

function model(tmpls: AnkiModel["tmpls"], css?: string): AnkiModel {
  return { id: "m1", name: "Vocab Card", type: 0, flds: [{ name: "Word" }, { name: "Reading" }], tmpls, css };
}

describe("AnkiTemplateExporter", () => {
  it("builds a decks-html template file keeping {{Field}} refs, wrapped in .card", () => {
    const tmpl = { name: "C1", ord: 0, qfmt: "<b>{{Word}}</b>", afmt: "{{FrontSide}}<hr id=answer>{{Reading}}" };
    const file = AnkiTemplateExporter.build(model([tmpl]), tmpl);
    expect(file.tag).toBe("anki-tpl/vocab-card-0");
    expect(file.relativePath).toBe("vocab-card-0.md");
    expect(file.content).toContain("tags:\n  - anki-tpl/vocab-card-0");
    expect(file.content).toContain('```decks-html-front\n<div class="card">\n<b>{{Word}}</b>\n</div>\n```');
    // Back keeps only the answer side (after <hr id=answer>), so no FrontSide.
    expect(file.content).toContain('```decks-html-back\n<div class="card">\n{{Reading}}\n</div>\n```');
    expect(file.content).not.toContain("FrontSide");
  });

  it("keeps conditionals, drops scripts, converts modifiers and media", () => {
    const tmpl = {
      name: "C1",
      ord: 0,
      qfmt: '{{#Word}}<i>{{Word}}</i>{{/Word}}{{^Word}}none{{/Word}}<script>x()</script>{{hint:Reading}}<img src="logo.png">',
      afmt: "{{FrontSide}}<hr id=answer>{{Reading}}",
    };
    const file = AnkiTemplateExporter.build(model([tmpl]), tmpl);
    expect(file.content).toContain("{{#Word}}<i>{{Word}}</i>{{/Word}}"); // conditionals preserved
    expect(file.content).toContain("{{^Word}}none{{/Word}}"); // negative section preserved
    expect(file.content).not.toContain("<script>");
    expect(file.content).toContain("{{Reading}}"); // {{hint:Reading}} → {{Reading}}
    expect(file.content).toContain("![[logo.png]]"); // static media → embed
  });

  it("injects the model CSS as a <style> block in both faces", () => {
    const tmpl = { name: "C1", ord: 0, qfmt: "{{Word}}", afmt: "{{FrontSide}}<hr id=answer>{{Reading}}" };
    const file = AnkiTemplateExporter.build(model([tmpl], ".card { display: grid; }"), tmpl);
    const styleBlocks = file.content.split("<style>").length - 1;
    expect(styleBlocks).toBe(2); // front + back
    expect(file.content).toContain("<style>\n.card { display: grid; }\n</style>");
  });
});
