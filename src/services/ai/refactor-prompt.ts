import type {
  RefactorCardType,
  RefactorFieldSet,
  RefactorProposal,
  RefactorRequest,
} from "./types";
import { AiError, REFACTOR_FIELD_KEYS } from "./types";

const FIELD_LABELS: Record<string, string> = {
  front: "Front",
  back: "Back",
  notes: "Notes",
  sentence: "Sentence",
  listItem: "List item",
  hint: "Hint",
};

/**
 * Always-on master prompt: teaches the model how Decks flashcards are built and
 * the spaced-repetition best practices to apply. Prepended to every refactor's
 * system message ahead of the per-profile prompt and per-card instructions.
 */
export const FLASHCARD_DESIGN_GUIDANCE = [
  "You are an expert in spaced-repetition flashcard design, working inside the Decks plugin for Obsidian.",
  "",
  "How Decks flashcards work:",
  "- Card text is rendered as Markdown. You may use Markdown formatting.",
  "- Math uses LaTeX with $inline$ delimiters and $$block$$ delimiters.",
  '- Cloze deletions wrap the hidden text in ==double equals== (e.g. "The capital is ==Paris=="). Each ==span== becomes a separately tested blank; a cloze card needs at least one span. Keep == markers and $ delimiters balanced.',
  "",
  "Principles for high-quality flashcards (apply these when rewriting):",
  "- Keep each card atomic: test one fact or idea (the minimum information principle). Split compound facts rather than cramming them in.",
  "- Make the front a specific, unambiguous prompt that elicits a single answer; avoid yes/no questions.",
  "- Keep answers concise; put elaboration or examples in the Notes field when the card type has one.",
  "- Preserve the original meaning and language. Never invent facts or add information that isn't supported.",
  "- Fix grammar, spelling, and formatting; ensure LaTeX delimiters and ==cloze== markers are valid and balanced.",
  "- Prefer phrasing that demands active recall; avoid long enumerations unless you express them as cloze deletions.",
].join("\n");

/**
 * Hardcoded instruction added (on top of the user's prompt) when split mode is
 * on — tells the model to break the card into several smaller atomic cards.
 */
export const SPLIT_INSTRUCTION = [
  "Split this flashcard into multiple smaller, single-idea cards (apply the minimum information principle).",
  "Each resulting card must keep the same field structure as the original card.",
  "Produce as many cards as the content naturally warrants (usually 2–5); do not pad with redundant cards.",
].join("\n");

const CARD_TYPE_FIELD_GUIDANCE: Record<RefactorCardType, string> = {
  "header-paragraph":
    'This is a "header / paragraph" card: "front" is the prompt heading; "back" is the answer/explanation below it.',
  table:
    'This is a "table" card: "front" is the prompt, "back" is the answer, "notes" is optional supplementary detail.',
  cloze:
    'This is a "cloze" card: "front" is a context heading; "sentence" is the text that contains the ==cloze== deletions (at least one).',
  spatial:
    'This is a "spatial" card: "front" is the prompt, "back" is the answer, "hint" is an optional hint.',
  "image-occlusion":
    'This is an "image-occlusion" card: "listItem" is the label text for the occluded region.',
};

/**
 * Per-card-type field semantics, plus format-safety caveats. Table cards are a
 * single pipe-delimited Markdown row, and the writer escapes "|" -> "\|" and
 * newlines -> <br> on save — which silently corrupts LaTeX containing literal
 * pipes (|x| becomes a norm) and breaks multi-line block math. So table fields
 * must avoid literal "|" and stay inline/single-line.
 */
export function cardTypeFieldGuidance(type: RefactorCardType): string {
  const lines = [CARD_TYPE_FIELD_GUIDANCE[type]];
  if (type === "table") {
    lines.push(
      "IMPORTANT (table format): each field is one cell of a single-line, pipe-delimited row. Never output a literal | character, and do not use $$block$$ math or line breaks. In LaTeX use \\lvert … \\rvert for absolute value, \\lVert … \\rVert for a norm, \\mid for \"divides\"/conditionals, and \\vert / \\Vert instead of |. Keep all math inline with $…$.",
    );
  }
  return lines.join("\n");
}

/** Extract the editable values of a field set as a plain key→string record. */
export function fieldsToRecord(fields: RefactorFieldSet): Record<string, string> {
  const keys = REFACTOR_FIELD_KEYS[fields.type];
  const record: Record<string, string> = {};
  const source = fields as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    record[key] = typeof value === "string" ? value : "";
  }
  return record;
}

/** Build the system + user messages for a refactor request. */
export function buildMessages(req: RefactorRequest): {
  system: string;
  user: string;
} {
  const allKeys = REFACTOR_FIELD_KEYS[req.current.type];
  // Fields the model may change. Default = all. A strict subset means the rest
  // are context-only.
  const targets =
    req.targetKeys && req.targetKeys.length > 0
      ? allKeys.filter((k) => req.targetKeys!.includes(k))
      : allKeys;
  const targetList = targets
    .map((k) => `"${k}" (${FIELD_LABELS[k] ?? k})`)
    .join(", ");

  const lines: (string | undefined)[] = [
    FLASHCARD_DESIGN_GUIDANCE,
    "",
    cardTypeFieldGuidance(req.current.type),
    "",
    req.prompt.trim(),
  ];

  const instructions = req.instructions?.trim();
  if (instructions) {
    lines.push("", "Additional instructions for this card:", instructions);
  }

  lines.push(
    "",
    `You may rewrite ONLY these fields: ${targetList}.`,
  );
  if (targets.length < allKeys.length) {
    const contextOnly = allKeys
      .filter((k) => !targets.includes(k))
      .map((k) => `"${k}" (${FIELD_LABELS[k] ?? k})`)
      .join(", ");
    lines.push(
      `The other fields (${contextOnly}) are provided for context only — do NOT modify them or include them in your output.`,
    );
  }

  if (req.split) {
    lines.push("", SPLIT_INSTRUCTION);
    lines.push(
      "Return ONLY a JSON array. Each element is an object whose keys are the rewritable field names",
      "and whose values are that new card's field text as strings; include every field of each card.",
      "Do not wrap the JSON in markdown fences or add any commentary.",
    );
  } else {
    lines.push(
      "Return ONLY a JSON object whose keys are a subset of the rewritable field names,",
      "and whose values are the rewritten field text as strings.",
      "Include a field only if you are changing it; omit fields you leave unchanged.",
      "Do not wrap the JSON in markdown fences or add any commentary.",
    );
  }

  const system = lines.filter((line) => line !== undefined).join("\n");

  // Always send all current field values so the model has holistic context.
  let user = JSON.stringify(fieldsToRecord(req.current), null, 2);
  const sourceContext = req.sourceContext?.trim();
  if (sourceContext) {
    user +=
      "\n\nSurrounding source-note context (for reference only, do not return it):\n" +
      sourceContext;
  }

  return { system, user };
}

/** Strip ```json fences and surrounding prose, returning the JSON substring.
 *  Handles both object (`{…}`) and array (`[…]`) payloads. */
function extractJson(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) {
    text = fence[1].trim();
  }
  if (text.startsWith("{") || text.startsWith("[")) return text;
  // Fall back to the first {...} / [...] block if the model added prose around it.
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const useArray =
    arrStart !== -1 && (objStart === -1 || arrStart < objStart);
  const start = useArray ? arrStart : objStart;
  const end = useArray ? text.lastIndexOf("]") : text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  return text;
}

/**
 * Parse JSON, tolerating the most common model mistake with LaTeX content:
 * lone backslashes that aren't valid JSON escapes (e.g. "$A = \pi r^2$"). We
 * first try strict parsing; only on failure do we escape those backslashes and
 * retry, so well-formed JSON is never altered.
 */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Escape any backslash not starting a valid JSON escape (\" \\ \/ \b \f
    // \n \r \t \uXXXX). Turns LaTeX like \pi, \frac, \underbrace into literal
    // backslashes the parser accepts.
    const repaired = text.replace(/\\(?![\\/"bfnrt]|u[0-9a-fA-F]{4})/g, "\\\\");
    return JSON.parse(repaired);
  }
}

/**
 * Parse the model's JSON output, keeping only known string-valued fields for
 * this card type and merging them onto the current values.
 */
export function parseProposed(
  raw: string,
  current: RefactorFieldSet,
  targetKeys?: string[],
): RefactorFieldSet {
  let obj: unknown;
  try {
    obj = parseJsonLoose(extractJson(raw));
  } catch {
    throw new AiError("invalid_output", "Model did not return valid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new AiError("invalid_output", "Model output was not a JSON object");
  }

  const allKeys = REFACTOR_FIELD_KEYS[current.type];
  // Only merge fields the caller allowed to change. Keys outside the set (or
  // unknown keys the model echoed) are silently ignored.
  const keys =
    targetKeys && targetKeys.length > 0
      ? allKeys.filter((k) => targetKeys.includes(k))
      : allKeys;
  const incoming = obj as Record<string, unknown>;
  const merged = { ...(current as unknown as Record<string, unknown>) };
  let sawKnownKey = false;
  for (const key of keys) {
    if (key in incoming && typeof incoming[key] === "string") {
      merged[key] = incoming[key];
      sawKnownKey = true;
    }
  }
  if (!sawKnownKey) {
    throw new AiError(
      "invalid_output",
      "Model output contained none of the expected fields",
    );
  }
  return merged as unknown as RefactorFieldSet;
}

/**
 * Parse a split response: a JSON array of card objects. Each element becomes a
 * full field set for `type` (string values for known keys, missing → ""). Cards
 * with no recognizable field are dropped; throws if none are usable.
 */
export function parseSplitProposed(
  raw: string,
  type: RefactorCardType,
): RefactorFieldSet[] {
  let arr: unknown;
  try {
    arr = parseJsonLoose(extractJson(raw));
  } catch {
    throw new AiError("invalid_output", "Model did not return valid JSON");
  }
  if (!Array.isArray(arr)) {
    throw new AiError("invalid_output", "Split output was not a JSON array");
  }

  const keys = REFACTOR_FIELD_KEYS[type];
  const cards: RefactorFieldSet[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const incoming = item as Record<string, unknown>;
    const card: Record<string, unknown> = { type };
    let sawKnownKey = false;
    for (const key of keys) {
      const value = incoming[key];
      if (typeof value === "string") {
        card[key] = value;
        sawKnownKey = true;
      } else {
        card[key] = "";
      }
    }
    if (sawKnownKey) cards.push(card as unknown as RefactorFieldSet);
  }

  if (cards.length === 0) {
    throw new AiError(
      "invalid_output",
      "Split output contained no usable cards",
    );
  }
  return cards;
}

/** Compute the list of fields that actually changed. */
export function diffFields(
  before: RefactorFieldSet,
  after: RefactorFieldSet,
): RefactorProposal[] {
  const beforeRec = fieldsToRecord(before);
  const afterRec = fieldsToRecord(after);
  const proposals: RefactorProposal[] = [];
  for (const key of REFACTOR_FIELD_KEYS[before.type]) {
    if (beforeRec[key] !== afterRec[key]) {
      proposals.push({ key, before: beforeRec[key], after: afterRec[key] });
    }
  }
  return proposals;
}
