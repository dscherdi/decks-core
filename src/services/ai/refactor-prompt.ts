import type {
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
  const keys = REFACTOR_FIELD_KEYS[req.current.type];
  const fieldList = keys
    .map((k) => `"${k}" (${FIELD_LABELS[k] ?? k})`)
    .join(", ");

  const system = [
    "You are an assistant that improves spaced-repetition flashcards.",
    req.prompt.trim(),
    "",
    `The flashcard has these editable fields: ${fieldList}.`,
    "Rewrite the fields according to the instructions above.",
    "Return ONLY a JSON object whose keys are a subset of the field names listed,",
    "and whose values are the rewritten field text as strings.",
    "Include a field only if you are changing it; omit fields you leave unchanged.",
    "Do not wrap the JSON in markdown fences or add any commentary.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const user = JSON.stringify(fieldsToRecord(req.current), null, 2);

  return { system, user };
}

/** Strip ```json fences and surrounding prose, returning the JSON substring. */
function extractJson(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) {
    text = fence[1].trim();
  }
  // Fall back to the first {...} block if the model added prose around it.
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }
  return text;
}

/**
 * Parse the model's JSON output, keeping only known string-valued fields for
 * this card type and merging them onto the current values.
 */
export function parseProposed(
  raw: string,
  current: RefactorFieldSet,
): RefactorFieldSet {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJson(raw));
  } catch {
    throw new AiError("invalid_output", "Model did not return valid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new AiError("invalid_output", "Model output was not a JSON object");
  }

  const keys = REFACTOR_FIELD_KEYS[current.type];
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
