import { wantsReverseCards } from "../frontmatter";

// Each case's answer is what Obsidian's metadata cache gives for `frontmatter.reverse === true`.
const note = (yaml: string): string => `---\n${yaml}\n---\n## Q\n\nA\n`;

describe("wantsReverseCards", () => {
  it.each([
    ["reverse: true"],
    ["reverse: True"],
    ["reverse: TRUE"],
    ["reverse: true # both ways"],
    ["reverse:   true   "],
    ["reverse: !!bool true"],
    ["reverse:\n  true"],
    ["tags: [decks]\nreverse: true"],
    ["status: !important done\nreverse: true"],
    ["? [a, b]\n: c\nreverse: true"],
  ])("is true for %j", (yaml) => {
    expect(wantsReverseCards(note(yaml))).toBe(true);
  });

  it.each([
    ["reverse: false"],
    ['reverse: "true"'],
    ["reverse: 'true'"],
    ["reverse: yes"],
    ["reverse: on"],
    ["reverse: tRuE"],
    ["reverse: 1"],
    ["reverse: [true]"],
    ["Reverse: true"],
    ["options:\n  reverse: true"],
    ["reverse: true\nreverse: true"],
    ["reverse: true\ntitle: 'unclosed"],
    ["reverse: !flag true"],
    ["reverse: true\nstatus: !important done\nstatus: x"],
  ])("is false for %j", (yaml) => {
    expect(wantsReverseCards(note(yaml))).toBe(false);
  });

  it("reads CRLF and lone-CR notes, and one with a byte-order mark", () => {
    expect(wantsReverseCards("---\r\nreverse: true\r\n---\r\n## Q\r\n")).toBe(true);
    expect(wantsReverseCards("---\rreverse: true\r---\r## Q\r")).toBe(true);
    expect(wantsReverseCards("\uFEFF---\nreverse: true\n---\n")).toBe(true);
  });

  it("needs the opening fence on the first line and a closing one", () => {
    expect(wantsReverseCards("\n---\nreverse: true\n---\n")).toBe(false);
    expect(wantsReverseCards("---\nreverse: true\n")).toBe(false);
    expect(wantsReverseCards("## Q\n\nreverse: true\n")).toBe(false);
  });

  it("closes at the first line that starts with ---", () => {
    expect(wantsReverseCards("---\nreverse: true\n--- \n## Q\n")).toBe(true);
    expect(wantsReverseCards("---\nreverse: true\n----\n## Q\n")).toBe(true);
    expect(wantsReverseCards("---\nreverse: true\n...\n## Q\n")).toBe(false);
  });

  it("is false for an empty or non-mapping block", () => {
    expect(wantsReverseCards("---\n---\n## Q\n")).toBe(false);
    expect(wantsReverseCards("---\n- reverse\n---\n")).toBe(false);
  });
});
