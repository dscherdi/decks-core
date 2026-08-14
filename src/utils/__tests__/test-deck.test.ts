import { FlashcardParser } from "../../services/FlashcardParser";
import { I18n } from "../../i18n/I18n";
import { DEFAULT_SETTINGS } from "../../settings";
import { SUPPORTED_LANGUAGES } from "../../i18n/locales";
import {
  getTemplateShowcaseContent,
  getTemplateShowcaseFolder,
  getTemplateShowcasePath,
  getTestDeckContent,
  getTestDeckPath,
} from "../test-deck";

const setLanguage = (code: string) => {
  I18n.init({ ...DEFAULT_SETTINGS, i18n: { language: code as "en" } });
};

afterEach(() => setLanguage("en"));

describe("the getting-started deck", () => {
  it("carries the deck tag in its frontmatter, so a scan finds it", () => {
    expect(getTestDeckContent("#decks")).toContain("tags:\n  - decks");
    // A configured tag is honoured, and the `#` never reaches the tags list.
    expect(getTestDeckContent("#study/cards")).toContain("tags:\n  - study/cards");
  });

  // The whole point of writing this file into an empty vault: a reviewer opens
  // the app and has something to review. An empty parse would look identical to
  // a broken install.
  it("parses into reviewable cards in every language core ships", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      setLanguage(language.code);
      const cards = FlashcardParser.parseFlashcardsFromContent(
        getTestDeckContent("#decks"),
        2,
        undefined,
        true,
      );
      expect(cards.length).toBeGreaterThan(0);
      // `undefined` in a front or back is a locale missing a key, which renders
      // literally rather than failing anywhere a test would notice.
      for (const card of cards) {
        expect(card.front).not.toContain("undefined");
        expect(card.back).not.toContain("undefined");
      }
    }
  });

  it("lands at the vault root, or inside the configured search folder", () => {
    expect(getTestDeckPath()).toBe(I18n.t.testDeck.filename);
    expect(getTestDeckPath("")).toBe(I18n.t.testDeck.filename);
    expect(getTestDeckPath("Notes/")).toBe(`Notes/${I18n.t.testDeck.filename}`);
  });
});

describe("the sample card template", () => {
  it("declares the tag that binds it to the deck's tagged table", () => {
    const tag = I18n.t.testDeck.templateTag;
    expect(getTemplateShowcaseContent()).toContain(`  - ${tag}`);
    expect(getTestDeckContent("#decks")).toContain(`#${tag}`);
  });

  it("uses positional variables, so localized column headers cannot break it", () => {
    const content = getTemplateShowcaseContent();
    expect(content).toContain("{{1}}");
    expect(content).toContain("{{2}}");
    expect(content).toContain("{{3}}");
  });

  it("falls back to the localized default folder only when none is configured", () => {
    expect(getTemplateShowcaseFolder("")).toBe(I18n.t.testDeck.templateFolderName);
    expect(getTemplateShowcaseFolder("  Templates/  ")).toBe("Templates");
    expect(getTemplateShowcasePath("Templates")).toBe(
      `Templates/${I18n.t.testDeck.templateFileName}`,
    );
  });
});
