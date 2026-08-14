import { FlashcardParser } from "../../services/FlashcardParser";
import { classifyExamBody } from "../../services/ExamClassifier";
import { I18n } from "../../i18n/I18n";
import { DEFAULT_SETTINGS } from "../../settings";
import { SUPPORTED_LANGUAGES } from "../../i18n/locales";
import {
  getExamDeckContent,
  getExamDeckFrontmatterTag,
  getExamDeckPath,
  getExamDeckTag,
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

describe("the demo exam deck", () => {
  // The Exams preset's parsing settings: H2 fronts, cloze on, questions on.
  const parse = (content: string, examEnabled = true) =>
    FlashcardParser.parseFlashcardsFromContent(
      content,
      2,
      undefined,
      true,
      examEnabled,
    );

  it("tags itself into the exams subtree, which the Exams preset is bound to", () => {
    expect(getExamDeckContent("#decks")).toContain("tags:\n  - decks/exams");
    // A configured base tag carries its own subtree with it.
    expect(getExamDeckContent("#study/cards")).toContain(
      "tags:\n  - study/cards/exams",
    );
  });

  // The frontmatter form is bare and the deck/tag-mapping form is `#`-prefixed.
  // Binding the preset with the bare form silently fails to match the deck, so
  // the questions land on the default profile and never become questions.
  it("distinguishes the frontmatter tag from the tag a mapping must match", () => {
    expect(getExamDeckFrontmatterTag("#decks")).toBe("decks/exams");
    expect(getExamDeckTag("#decks")).toBe("#decks/exams");
    // A base tag configured without its `#` still resolves to the same pair.
    expect(getExamDeckFrontmatterTag("decks")).toBe("decks/exams");
    expect(getExamDeckTag("decks")).toBe("#decks/exams");
  });

  it("lands at the vault root, or inside the configured search folder", () => {
    expect(getExamDeckPath()).toBe(I18n.t.examDeck.filename);
    expect(getExamDeckPath("")).toBe(I18n.t.examDeck.filename);
    expect(getExamDeckPath("Notes/")).toBe(`Notes/${I18n.t.examDeck.filename}`);
  });

  // Why the note needs a profile of its own: the task-list rule is gated, so on
  // a deck using the default profile these questions stay inert checklists and
  // the feature reads as broken rather than undemonstrated.
  it("yields no questions at all when the deck's profile has exams off", () => {
    const cards = parse(getExamDeckContent("#decks"), false);
    expect(cards.filter((c) => c.type === "multiple-choice")).toHaveLength(0);
  });

  it("produces its question set in every language core ships", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      setLanguage(language.code);
      const cards = parse(getExamDeckContent("#decks"));
      const questions = cards.filter((c) => c.type === "multiple-choice");

      // Single answer, multiple answers, true/false — in document order.
      expect(questions).toHaveLength(3);
      const shape = questions.map((question) => {
        const parsed = classifyExamBody(question.back);
        if (parsed.kind !== "mcq") {
          throw new Error(
            `${language.code}: "${question.front}" did not parse as a question (${parsed.kind})`,
          );
        }
        return {
          options: parsed.options.length,
          correct: parsed.options.filter((o) => o.correct).length,
        };
      });
      expect(shape).toEqual([
        { options: 4, correct: 1 },
        { options: 4, correct: 3 },
        { options: 2, correct: 1 },
      ]);

      // The `%%comment%%` that becomes the explanation in the results review.
      expect(questions[0].notes).toBeTruthy();

      // `undefined` in a face is a locale missing a key, which renders
      // literally rather than failing anywhere a test would notice.
      for (const card of cards) {
        expect(card.front).not.toContain("undefined");
        expect(card.back).not.toContain("undefined");
      }
    }
  });
});
