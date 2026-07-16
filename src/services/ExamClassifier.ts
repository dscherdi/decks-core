/**
 * Shared classifier deciding whether a card body is a multiple-choice
 * question. Single source of truth for the parser gate, exam rendering,
 * FSRS-review rendering and card-health validation. Input is the
 * anchor-stripped, notes-stripped body text (true for both the parser
 * path and a stored card's `back`).
 */

export interface ExamOption {
  text: string;
  correct: boolean;
}

export type ExamInvalidReason =
  | "no-correct-answer"
  | "single-option"
  | "mixed-list"
  | "nested-task-list"
  | "empty-option";

export type ExamBodyClassification =
  | { kind: "mcq"; stem: string; options: ExamOption[] }
  | { kind: "invalid"; reason: ExamInvalidReason }
  | { kind: "plain" };

const TASK_ITEM_REGEX = /^[-*+] \[( |x|X)\](?:\s+(.*))?$/;
const PLAIN_BULLET_REGEX = /^[-*+] (?!\[( |x|X)\])/;

/** Classify a card body against the task-list question rule. */
export function classifyExamBody(back: string): ExamBodyClassification {
  const lines = back.split("\n");

  interface RawOption {
    correct: boolean;
    parts: string[];
  }
  const options: RawOption[] = [];
  const stemLines: string[] = [];
  let sawNested = false;
  let sawMixed = false;
  let firstItemSeen = false;

  for (const line of lines) {
    const isIndented = /^\s/.test(line);
    const trimmedLeft = line.replace(/^\s+/, "");
    const taskMatch = trimmedLeft.match(TASK_ITEM_REGEX);

    // Thematic breaks are separators (also the notes-divider syntax), never
    // question content — a trailing `---` must not read as a mixed list.
    if (firstItemSeen && /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) continue;

    if (!isIndented && taskMatch) {
      if (!firstItemSeen) {
        // A plain bullet directly adjacent above belongs to the same list.
        const prev = stemLines[stemLines.length - 1];
        if (prev !== undefined && PLAIN_BULLET_REGEX.test(prev)) {
          sawMixed = true;
        }
      }
      firstItemSeen = true;
      options.push({
        correct: taskMatch[1] !== " ",
        parts: [taskMatch[2] ?? ""],
      });
      continue;
    }
    if (!firstItemSeen) {
      // Content above the first task item is the question stem.
      stemLines.push(line);
      continue;
    }
    if (line.trim() === "") continue;
    if (isIndented) {
      if (taskMatch) {
        sawNested = true;
      } else if (options.length > 0) {
        // Indented non-task lines are the option's own markdown.
        options[options.length - 1].parts.push(trimmedLeft);
      }
      continue;
    }
    // Top-level non-task content after the list started: not a clean question.
    sawMixed = true;
  }

  if (!firstItemSeen) return { kind: "plain" };
  if (sawNested) return { kind: "invalid", reason: "nested-task-list" };
  if (sawMixed) return { kind: "invalid", reason: "mixed-list" };

  const built: ExamOption[] = options.map((o) => ({
    correct: o.correct,
    text: o.parts.join("\n").trim(),
  }));
  if (built.some((o) => o.text === "")) {
    return { kind: "invalid", reason: "empty-option" };
  }
  if (built.length < 2) return { kind: "invalid", reason: "single-option" };
  if (!built.some((o) => o.correct)) {
    return { kind: "invalid", reason: "no-correct-answer" };
  }

  return {
    kind: "mcq",
    stem: stemLines.join("\n").trim(),
    options: built,
  };
}
