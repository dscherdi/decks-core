import {
  extractTemplateBlocks,
  stripTemplateBlocks,
} from "../CodeblockTemplateParser";
import {
  mergeTemplate,
  referencedVariables,
  templateIsSatisfied,
} from "../TemplateMerger";
import type { ResolvedTemplateSet } from "../types";

describe("CodeblockTemplateParser", () => {
  it("extracts html and md blocks per side and engine", () => {
    const content = [
      "```decks-html-front",
      "<b>{{Word}}</b>",
      "```",
      "",
      "```decks-md-back",
      "Definition: {{2}}",
      "```",
    ].join("\n");
    const set = extractTemplateBlocks(content);
    expect(set.front).toEqual({ engine: "html", template: "<b>{{Word}}</b>" });
    expect(set.back).toEqual({ engine: "md", template: "Definition: {{2}}" });
    expect(set.notes).toBeUndefined();
  });

  it("strips template-definition blocks from content", () => {
    const content = [
      "```decks-html-front",
      "<b>{{1}}</b>",
      "```",
      "rest",
    ].join("\n");
    const stripped = stripTemplateBlocks(content);
    expect(stripped).not.toContain("decks-html-front");
    expect(stripped).toContain("rest");
  });
});

describe("TemplateMerger", () => {
  const headers = ["Word", "Definition", "Example"];
  const cells = ["Bonjour", "Hello", "Bonjour le monde"];

  it("resolves named columns case-insensitively", () => {
    expect(mergeTemplate("{{Word}} = {{definition}}", cells, headers)).toBe(
      "Bonjour = Hello"
    );
  });

  it("resolves positional indices ignoring headers", () => {
    expect(mergeTemplate("{{1}}/{{3}}", cells, headers)).toBe(
      "Bonjour/Bonjour le monde"
    );
  });

  it("mixes named and positional in one template", () => {
    expect(mergeTemplate("{{Word}} ({{2}})", cells, headers)).toBe(
      "Bonjour (Hello)"
    );
  });

  it("resolves unknown references to empty string", () => {
    expect(mergeTemplate("{{Missing}}{{9}}", cells, headers)).toBe("");
  });

  it("lists referenced variables", () => {
    expect(referencedVariables("{{Word}} {{1}} {{Word}}")).toEqual([
      "Word",
      "1",
    ]);
  });

  it("is satisfied only when front variables resolve", () => {
    const set: ResolvedTemplateSet = {
      front: { engine: "md", template: "{{Word}}" },
    };
    expect(templateIsSatisfied(set, cells, headers)).toBe(true);
    expect(templateIsSatisfied(set, ["", "Hello"], headers)).toBe(false);
    expect(templateIsSatisfied(set, ["x"], ["Other"])).toBe(false);
  });
});
