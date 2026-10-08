import { classifyExamBody } from "../ExamClassifier";
import { FlashcardParser } from "../FlashcardParser";
import type { ExamInvalidReason, ExamOption } from "../ExamClassifier";
import { headingHashes, sourcePageNote } from "./compose";
import type { GeneratedCard } from "./generation-prompt";

/** A generated question, once its body has been read as a task list. */
export interface StagedMcq {
  stem: string;
  options: ExamOption[];
  /** Indices into `options`; several means multi-select, graded all-or-nothing. */
  correct: number[];
  explanation: string;
}

/** Why a generated card is not a usable question. */
export type McqProblem = ExamInvalidReason | "not-a-question";

export type McqCheck =
  | { valid: true; mcq: StagedMcq }
  | { valid: false; reason: McqProblem };

/** Read a generated card as a question, using the classifier the parser and the
 *  exam surface already use. */
export function checkGeneratedMcq(card: GeneratedCard): McqCheck {
  // The classifier wants the body as the parser hands it over: a `%%…%%` left
  // in reads as a plain bullet and the question is called invalid.
  const { back, notes } = FlashcardParser.extractHeaderParagraphNotes(card.back);
  const classified = classifyExamBody(back);
  if (classified.kind === "plain") {
    return { valid: false, reason: "not-a-question" };
  }
  if (classified.kind === "invalid") {
    return { valid: false, reason: classified.reason };
  }
  // A generated card is one question; several checklists are not one.
  if (classified.kind === "exercise") {
    return { valid: false, reason: "mixed-list" };
  }
  const stem = classified.stem
    ? `${card.front}\n\n${classified.stem}`
    : card.front;
  const correct = classified.options
    .map((o, i) => (o.correct ? i : -1))
    .filter((i) => i >= 0);
  return {
    valid: true,
    mcq: {
      stem,
      options: classified.options,
      correct,
      // An explanation the model put in the body counts too; NOTES wins.
      explanation: card.notes.trim() || notes.trim(),
    },
  };
}

/** Render a question as the markdown Decks parses: a heading, a task list, and
 *  the explanation as a comment beneath it. */
export function buildMcqMarkdown(card: GeneratedCard, level: number): string {
  const check = checkGeneratedMcq(card);
  const heading = `${headingHashes(level)} ${card.front.trim().replace(/\n+/g, " ")}`;
  if (!check.valid) {
    // Written as-is rather than dropped: a question the user chose to save is
    // theirs to fix, and silently omitting it would hide the problem.
    return `${heading}\n\n${card.back.trim()}`;
  }
  const options = check.mcq.options
    .map((o) => `- [${o.correct ? "x" : " "}] ${o.text}`)
    .join("\n");
  // The page rides the comment, as it rides notes on other cards.
  const note = [check.mcq.explanation, card.page ? sourcePageNote(card.page) : ""]
    .filter(Boolean)
    .join("\n\n");
  const explanation = note ? `\n\n%%${note}%%` : "";
  return `${heading}\n\n${options}${explanation}`;
}

/** Full document body for a list of questions. */
export function buildMcqContent(
  cards: readonly GeneratedCard[],
  level: number,
): string {
  return cards.map((c) => buildMcqMarkdown(c, level)).join("\n\n");
}
