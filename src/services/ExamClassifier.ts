/**
 * Shared classifier deciding whether a card body is a multiple-choice
 * question or an exercise (shared material plus several questions). Single
 * source of truth for the parser gate, exam rendering, FSRS-review rendering
 * and card-health validation. Input is the anchor-stripped body; an
 * exercise body keeps its `%%…%%` comments, which hold per-question notes.
 */

import { isAnchorCommentBody } from "../utils/anchors";
import { scanClozeDeletions } from "../utils/cloze-scanner";

export interface ExamOption {
  text: string;
  correct: boolean;
}

export type ExamInvalidReason =
  | "no-correct-answer"
  | "single-option"
  | "mixed-list"
  | "nested-task-list"
  | "empty-option"
  | "empty-question"
  | "empty-answer";

/** One question of an exercise: options to choose, an answer to type, or blanks to fill. */
export type ExamExerciseItem =
  | { kind: "choice"; stem: string; options: ExamOption[]; notes: string }
  | { kind: "typed"; stem: string; answer: string; notes: string }
  | { kind: "cloze"; stem: string; text: string; notes: string };

export type ExamBodyClassification =
  | { kind: "mcq"; stem: string; options: ExamOption[] }
  | { kind: "exercise"; shared: string; items: ExamExerciseItem[]; notes: string }
  | { kind: "invalid"; reason: ExamInvalidReason }
  | { kind: "plain" };

const TASK_ITEM_REGEX = /^[-*+] \[( |x|X)\](?:\s+(.*))?$/;
const PLAIN_BULLET_REGEX = /^[-*+] (?!\[( |x|X)\])/;

/** Classify a card body against the task-list question rule. */
export function classifyExamBody(back: string): ExamBodyClassification {
  const byHeading = classifyHeadingExercise(back);
  if (byHeading) return byHeading;
  const single = classifySingleList(back);
  if (single.kind !== "invalid" || single.reason !== "mixed-list") return single;
  return classifyExercise(back) ?? single;
}

/** How many exam questions an exercise item asks: one, or one per blank. */
export function exerciseItemQuestionCount(item: ExamExerciseItem): number {
  return item.kind === "cloze" ? scanClozeDeletions(item.text).length : 1;
}

/** How many exam questions a body holds: zero when it is not a question. */
export function examQuestionCount(back: string): number {
  const classified = classifyExamBody(back);
  if (classified.kind === "mcq") return 1;
  if (classified.kind === "exercise") {
    return classified.items.reduce((sum, item) => sum + exerciseItemQuestionCount(item), 0);
  }
  return 0;
}

function classifySingleList(back: string): ExamBodyClassification {
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

const COMMENT_REGEX = /%%([\s\S]*?)%%/g;
const NOTE_MARKER = "\u0000";
const FENCE_REGEX = /^(`{3,}|~{3,})/;
const RULE_REGEX = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING_REGEX = /^#{1,6}\s+(.*)$/;

type ExerciseLine =
  | { kind: "task"; correct: boolean; text: string }
  | { kind: "continuation"; text: string }
  | { kind: "blank" }
  | { kind: "note"; text: string }
  | { kind: "rule"; raw: string }
  | { kind: "heading"; text: string; raw: string }
  | { kind: "content"; raw: string };

/**
 * Comments on lines of their own become note markers; inline ones are cut
 * from the text and kept as loose notes. Anchor comments are dropped.
 */
function extractComments(back: string): { text: string; notes: string[]; loose: string[] } {
  const notes: string[] = [];
  const loose: string[] = [];
  const text = back.replace(COMMENT_REGEX, (match, inner: string, offset: number) => {
    const body = inner.trim();
    if (isAnchorCommentBody(body)) return "";
    const before = back.slice(back.lastIndexOf("\n", offset - 1) + 1, offset);
    const afterEnd = back.indexOf("\n", offset + match.length);
    const after = back.slice(offset + match.length, afterEnd === -1 ? back.length : afterEnd);
    if (before.trim() === "" && after.trim() === "") {
      notes.push(body);
      return `${NOTE_MARKER}${notes.length - 1}`;
    }
    if (body) loose.push(body);
    return "";
  });
  return { text, notes, loose };
}

function readExerciseLines(text: string, notes: string[]): ExerciseLine[] | "nested" {
  const out: ExerciseLine[] = [];
  let inFence = false;
  let inList = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const isIndented = /^\s/.test(line);
    if (FENCE_REGEX.test(trimmed)) {
      inFence = !inFence;
      out.push(isIndented && inList ? { kind: "continuation", text: line.replace(/^\s+/, "") } : { kind: "content", raw: line });
      continue;
    }
    if (inFence) {
      out.push(isIndented && inList ? { kind: "continuation", text: line.replace(/^\s+/, "") } : { kind: "content", raw: line });
      continue;
    }
    if (trimmed.startsWith(NOTE_MARKER)) {
      out.push({ kind: "note", text: notes[Number(trimmed.slice(1))] ?? "" });
      continue;
    }
    if (trimmed === "") {
      out.push({ kind: "blank" });
      continue;
    }
    const task = line.match(TASK_ITEM_REGEX);
    if (task) {
      inList = true;
      out.push({ kind: "task", correct: task[1] !== " ", text: task[2] ?? "" });
      continue;
    }
    if (isIndented && inList) {
      if (TASK_ITEM_REGEX.test(line.replace(/^\s+/, ""))) return "nested";
      out.push({ kind: "continuation", text: line.replace(/^\s+/, "") });
      continue;
    }
    if (RULE_REGEX.test(trimmed)) {
      out.push({ kind: "rule", raw: line });
      continue;
    }
    inList = false;
    const heading = line.match(HEADING_REGEX);
    out.push(heading ? { kind: "heading", text: heading[1].trim(), raw: line } : { kind: "content", raw: line });
  }
  return out;
}

interface ExerciseSegment {
  list: ExerciseLine[];
  before: ExerciseLine[];
}

/** Markdown of a run of lines with notes and separator rules at either end removed. */
function joinContent(lines: ExerciseLine[], loose: string[]): string {
  const kept: string[] = [];
  for (const line of lines) {
    if (line.kind === "note") {
      if (line.text) loose.push(line.text);
    } else if (line.kind === "blank") {
      kept.push("");
    } else if (line.kind === "content" || line.kind === "rule" || line.kind === "heading") {
      kept.push(line.raw);
    }
  }
  while (kept.length > 0 && (kept[0].trim() === "" || RULE_REGEX.test(kept[0].trim()))) kept.shift();
  while (kept.length > 0 && (kept[kept.length - 1].trim() === "" || RULE_REGEX.test(kept[kept.length - 1].trim()))) kept.pop();
  return kept.join("\n");
}

/** Split the material before the first checklist into shared text and the first question. */
function splitLeadingContent(lines: ExerciseLine[], loose: string[]): { shared: string; stem: string } {
  let end = lines.length;
  while (end > 0 && lines[end - 1].kind !== "content" && lines[end - 1].kind !== "heading") end--;
  let start = end;
  while (start > 0 && lines[start - 1].kind !== "blank") start--;
  return {
    shared: joinContent(lines.slice(0, start), loose),
    stem: joinContent(lines.slice(start, end), loose),
  };
}

/**
 * An exercise: optional shared material, then two or more questions, each
 * the text directly above its checklist. A comment after a checklist is that
 * question's note; text after a rule below the last checklist is the
 * exercise's note. Null when the body has no such shape.
 */
function classifyExercise(back: string): ExamBodyClassification | null {
  const { text, notes, loose } = extractComments(back);
  const lines = readExerciseLines(text, notes);
  if (lines === "nested") return { kind: "invalid", reason: "nested-task-list" };
  // Headings make questions of their own; see classifyHeadingExercise.
  if (lines.some((line) => line.kind === "heading")) return null;

  const segments: ExerciseSegment[] = [];
  let pending: ExerciseLine[] = [];
  let current: ExerciseSegment | null = null;
  for (const line of lines) {
    if (line.kind === "task") {
      if (!current) {
        const previous = pending[pending.length - 1];
        if (previous?.kind === "content" && PLAIN_BULLET_REGEX.test(previous.raw)) {
          return { kind: "invalid", reason: "mixed-list" };
        }
        current = { list: [], before: pending };
        segments.push(current);
        pending = [];
      }
      current.list.push(line);
    } else if ((line.kind === "content" || line.kind === "heading") && current) {
      current = null;
      pending.push(line);
    } else if (current) {
      current.list.push(line);
    } else {
      pending.push(line);
    }
  }
  if (segments.length < 2) return null;
  if (pending.length > 0) {
    // Text below the last checklist counts only as the exercise's note, after a rule.
    const last = segments[segments.length - 1].list;
    const lastOption = last.map((line) => line.kind).lastIndexOf("task");
    if (!last.slice(lastOption).some((line) => line.kind === "rule")) return null;
  }

  const leading = splitLeadingContent(segments[0].before, loose);
  const shared = leading.shared;
  const stems = segments.map((segment, index) => (index === 0 ? leading.stem : joinContent(segment.before, loose)));

  const items: ExamExerciseItem[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const stem = stems[index];
    if (stem.trim() === "") return { kind: "invalid", reason: "empty-question" };
    const options: Array<{ correct: boolean; parts: string[] }> = [];
    const itemNotes: string[] = [];
    for (const line of segment.list) {
      if (line.kind === "task") options.push({ correct: line.correct, parts: [line.text] });
      else if (line.kind === "continuation") options[options.length - 1]?.parts.push(line.text);
      else if (line.kind === "note" && line.text) itemNotes.push(line.text);
    }
    const built = options.map((o) => ({ correct: o.correct, text: o.parts.join("\n").trim() }));
    if (built.some((o) => o.text === "")) return { kind: "invalid", reason: "empty-option" };
    if (built.length < 2) return { kind: "invalid", reason: "single-option" };
    if (!built.some((o) => o.correct)) return { kind: "invalid", reason: "no-correct-answer" };
    items.push({ kind: "choice", stem, options: built, notes: itemNotes.join("\n\n") });
  }
  const trailing = joinContent(pending, loose);

  return {
    kind: "exercise",
    shared,
    items,
    notes: [...loose, trailing].filter((note) => note !== "").join("\n\n"),
  };
}

function hasHeadingLine(back: string): boolean {
  let inFence = false;
  for (const line of back.split("\n")) {
    if (FENCE_REGEX.test(line.trim())) inFence = !inFence;
    else if (!inFence && HEADING_REGEX.test(line)) return true;
  }
  return false;
}

function optionsOf(lines: ExerciseLine[]): ExamOption[] {
  const options: Array<{ correct: boolean; parts: string[] }> = [];
  for (const line of lines) {
    if (line.kind === "task") options.push({ correct: line.correct, parts: [line.text] });
    else if (line.kind === "continuation") options[options.length - 1]?.parts.push(line.text);
  }
  return options.map((o) => ({ correct: o.correct, text: o.parts.join("\n").trim() }));
}

function notesOf(lines: ExerciseLine[]): string {
  return lines
    .flatMap((line) => (line.kind === "note" && line.text ? [line.text] : []))
    .join("\n\n");
}

/**
 * An exercise whose questions are headings: the text before the first is
 * shared; under each heading, a checklist makes a choice, `==highlights==`
 * blanks to fill, and any other text the answer to type. Two or more
 * questions; null when the body has no such shape.
 */
function classifyHeadingExercise(back: string): ExamBodyClassification | null {
  if (!hasHeadingLine(back)) return null;
  const { text, notes, loose } = extractComments(back);
  const lines = readExerciseLines(text, notes);
  if (lines === "nested") return null;
  const first = lines.findIndex((line) => line.kind === "heading");
  const sections: Array<{ heading: string; body: ExerciseLine[] }> = [];
  for (const line of lines.slice(first)) {
    if (line.kind === "heading") sections.push({ heading: line.text, body: [] });
    else sections[sections.length - 1].body.push(line);
  }
  const before = lines.slice(0, first);
  // With question headings, a checklist above the first one has no question.
  if (before.some((line) => line.kind === "task")) return { kind: "invalid", reason: "empty-question" };
  if (sections.length < 2) return null;

  // Text after a rule at the very end is the exercise's own note.
  const exerciseNotes: string[] = [];
  const last = sections[sections.length - 1].body;
  const rule = last.map((line) => line.kind).lastIndexOf("rule");
  if (rule >= 0 && !last.slice(rule).some((line) => line.kind === "task") && last.slice(rule).some((line) => line.kind === "content")) {
    const trailing = joinContent(last.slice(rule + 1), loose);
    if (trailing) exerciseNotes.push(trailing);
    sections[sections.length - 1].body = last.slice(0, rule);
  }

  const items: ExamExerciseItem[] = [];
  for (const section of sections) {
    const body = section.body;
    const firstTask = body.findIndex((line) => line.kind === "task");
    if (firstTask >= 0) {
      let end = firstTask;
      while (end < body.length && body[end].kind !== "content") end++;
      if (body.slice(end).some((line) => line.kind === "content" || line.kind === "task")) {
        return { kind: "invalid", reason: "mixed-list" };
      }
      const lead = body.slice(0, firstTask);
      const previous = lead[lead.length - 1];
      if (previous?.kind === "content" && PLAIN_BULLET_REGEX.test(previous.raw)) {
        return { kind: "invalid", reason: "mixed-list" };
      }
      const options = optionsOf(body.slice(firstTask, end));
      if (options.some((o) => o.text === "")) return { kind: "invalid", reason: "empty-option" };
      if (options.length < 2) return { kind: "invalid", reason: "single-option" };
      if (!options.some((o) => o.correct)) return { kind: "invalid", reason: "no-correct-answer" };
      const extra = joinContent(lead.filter((line) => line.kind !== "note"), loose);
      items.push({
        kind: "choice",
        stem: [section.heading, extra].filter((part) => part !== "").join("\n\n"),
        options,
        notes: notesOf(body),
      });
      continue;
    }
    const answer = joinContent(body.filter((line) => line.kind !== "note"), loose);
    if (answer === "") return { kind: "invalid", reason: "empty-answer" };
    const itemNotes = notesOf(body);
    items.push(
      scanClozeDeletions(answer).length > 0
        ? { kind: "cloze", stem: section.heading, text: answer, notes: itemNotes }
        : { kind: "typed", stem: section.heading, answer, notes: itemNotes }
    );
  }

  return {
    kind: "exercise",
    shared: joinContent(before.filter((line) => line.kind !== "note"), loose),
    items,
    notes: [...notesOf(before).split("\n\n").filter(Boolean), ...loose, ...exerciseNotes].join("\n\n"),
  };
}
