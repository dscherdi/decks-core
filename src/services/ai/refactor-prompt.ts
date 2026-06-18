import type {
  RefactorCardType,
  RefactorFieldSet,
  RefactorProposal,
  RefactorRequest,
} from "./types";
import { AiError, REFACTOR_FIELD_KEYS } from "./types";
import { CARD_DELIMITER, DECKS_OVERVIEW, SPLIT_INSTRUCTION } from "./prompts";

const FIELD_LABELS: Record<string, string> = {
  front: "Front",
  back: "Back",
  notes: "Notes",
  sentence: "Sentence",
  listItem: "List item",
  hint: "Hint",
};

/** Field key → uppercase output label used in the markdown response format. */
const KEY_TO_LABEL: Record<string, string> = {
  front: "FRONT",
  back: "BACK",
  notes: "NOTES",
  sentence: "SENTENCE",
  hint: "HINT",
  listItem: "LIST ITEM",
};
const LABEL_TO_KEY: Record<string, string> = {
  FRONT: "front",
  BACK: "back",
  NOTES: "notes",
  SENTENCE: "sentence",
  HINT: "hint",
  "LIST ITEM": "listItem",
};
const LABEL_RE = /^\s*(FRONT|BACK|NOTES|SENTENCE|HINT|LIST ITEM)\s*:(.*)$/i;

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

/** The markdown output-format contract for a set of editable field keys. */
function outputContract(keys: string[], split: boolean): string {
  const labelList = keys.map((k) => `${KEY_TO_LABEL[k]}:`).join(" / ");
  return [
    split
      ? "Output ONE block per resulting card, each in EXACTLY this labelled format:"
      : "Output the rewritten card in EXACTLY this labelled format:",
    ...keys.map((k) => `${KEY_TO_LABEL[k]}: <the new ${FIELD_LABELS[k] ?? k}>`),
    CARD_DELIMITER,
    "",
    "Rules for the output:",
    `- Start each field on its own line with its label (${labelList}).`,
    "- A field value may span multiple lines and may contain Markdown and $LaTeX$.",
    `- End every card block with a line containing only ${CARD_DELIMITER}.`,
    split
      ? "- Produce one block per card; do not number them, and add no other prose."
      : "- Output exactly one card block, including every field shown above; add no JSON, fences, or other prose.",
  ].join("\n");
}

/** Build the system + user messages for a refactor request. */
export function buildMessages(req: RefactorRequest): {
  system: string;
  user: string;
} {
  const allKeys = REFACTOR_FIELD_KEYS[req.current.type];
  const targets =
    req.targetKeys && req.targetKeys.length > 0
      ? allKeys.filter((k) => req.targetKeys!.includes(k))
      : allKeys;
  const targetList = targets
    .map((k) => `"${k}" (${FIELD_LABELS[k] ?? k})`)
    .join(", ");

  // System role: master prompt → task framing → card-type guidance → contract.
  const sys: string[] = [
    DECKS_OVERVIEW,
    "",
    req.split
      ? "TASK: You are SPLITTING an existing Decks flashcard into multiple smaller, single-idea cards."
      : "TASK: You are REFACTORING an existing Decks flashcard — rewrite the requested fields to improve clarity, correctness, and concision without changing the meaning.",
    "",
    cardTypeFieldGuidance(req.current.type),
  ];
  if (req.split) sys.push("", SPLIT_INSTRUCTION);
  sys.push("", `You may rewrite ONLY these fields: ${targetList}.`);
  if (targets.length < allKeys.length) {
    const contextOnly = allKeys
      .filter((k) => !targets.includes(k))
      .map((k) => `"${k}" (${FIELD_LABELS[k] ?? k})`)
      .join(", ");
    sys.push(
      `The other fields (${contextOnly}) are provided for context only — do NOT modify them or include them in your output.`,
    );
  }
  sys.push("", outputContract(targets, !!req.split));
  const system = sys.join("\n");

  // User role: current card → context → the user's instructions.
  const record = fieldsToRecord(req.current);
  const parts: string[] = ["Current card:"];
  for (const k of allKeys) parts.push(`${KEY_TO_LABEL[k]}: ${record[k]}`);
  const sourceContext = req.sourceContext?.trim();
  if (sourceContext) {
    parts.push(
      "",
      "Surrounding source context (for reference only, do not return it):",
      sourceContext,
    );
  }
  const instructions = req.instructions?.trim();
  if (instructions) parts.push("", "Instructions:", instructions);

  return { system, user: parts.join("\n") };
}

/** Parse one labelled card block into its allowed field values. */
function parseLabeledBlock(
  segment: string,
  keys: string[],
): { values: Record<string, string>; sawKnown: boolean } {
  const allowed = new Set(keys);
  const buf: Record<string, string[]> = {};
  let current: string | null = null;
  let sawKnown = false;
  for (const line of segment.split("\n")) {
    const m = LABEL_RE.exec(line);
    if (m) {
      const key = LABEL_TO_KEY[m[1].toUpperCase()];
      current = allowed.has(key) ? key : null;
      if (current) {
        (buf[current] ??= []).push(m[2]);
        sawKnown = true;
      }
    } else if (current) {
      buf[current].push(line);
    }
  }
  const values: Record<string, string> = {};
  for (const k of keys) if (buf[k]) values[k] = buf[k].join("\n").trim();
  return { values, sawKnown };
}

/**
 * Parse the model's markdown output (labelled fields, first block only),
 * merging the recognized fields onto the current values.
 */
export function parseProposed(
  raw: string,
  current: RefactorFieldSet,
  targetKeys?: string[],
): RefactorFieldSet {
  const allKeys = REFACTOR_FIELD_KEYS[current.type];
  const keys =
    targetKeys && targetKeys.length > 0
      ? allKeys.filter((k) => targetKeys.includes(k))
      : allKeys;
  const segment = raw.split(CARD_DELIMITER)[0] ?? raw;
  const { values, sawKnown } = parseLabeledBlock(segment, keys);
  if (!sawKnown) {
    throw new AiError(
      "invalid_output",
      "Model output contained none of the expected fields",
    );
  }
  const merged = { ...(current as unknown as Record<string, unknown>) };
  for (const k of keys) if (k in values) merged[k] = values[k];
  return merged as unknown as RefactorFieldSet;
}

/**
 * Parse a split response: one labelled block per card (separated by the
 * delimiter). Missing fields default to "". Blocks with no recognizable field
 * are dropped; throws if none are usable.
 */
export function parseSplitProposed(
  raw: string,
  type: RefactorCardType,
): RefactorFieldSet[] {
  const keys = REFACTOR_FIELD_KEYS[type];
  const cards: RefactorFieldSet[] = [];
  for (const segment of raw.split(CARD_DELIMITER)) {
    const { values, sawKnown } = parseLabeledBlock(segment, keys);
    if (!sawKnown) continue;
    const card: Record<string, unknown> = { type };
    for (const k of keys) card[k] = values[k] ?? "";
    cards.push(card as unknown as RefactorFieldSet);
  }
  if (cards.length === 0) {
    throw new AiError("invalid_output", "Split output contained no usable cards");
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
