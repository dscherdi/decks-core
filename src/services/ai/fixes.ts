import { I18n } from "../../i18n/I18n";
import type { RubricCode } from "./critique-prompt";
import type { GeneratedCard, GeneratedCardType } from "./generation-prompt";
import type { RefactorFieldSet } from "./types";

/** What a flagged card offers to do about it, derived from the rubric code so
 *  the button never disagrees with the chip. */
export type FixAction =
  | "split"
  | "cloze"
  | "rewrite"
  | "add_context"
  | "even_out"
  | "replace_distractor"
  | "flatten"
  | "type_in";

const ACTION_BY_CODE: Record<RubricCode, FixAction> = {
  // Two distractor faults have a fix of their own; the rest rewrite the options.
  length_cue: "even_out",
  implausible_distractor: "replace_distractor",
  two_defensible: "rewrite",
  negation_stem: "rewrite",
  all_of_the_above: "rewrite",
  stem_leak: "rewrite",
  // A list becomes one blank per item, so it stays one note and each item is rated alone.
  enumeration: "cloze",
  two_facts: "split",
  // The question gives itself away, so the question is what has to change.
  answer_leak: "rewrite",
  // Nothing is wrong with the card except that it left its context behind.
  unanswerable_alone: "add_context",
  trivial: "rewrite",
};

/** One action for a set of codes: split, cloze, add context, a lone option fix, else
 *  rewrite. A question cannot become a cloze, so it splits instead. */
export function fixActionFor(
  codes: readonly RubricCode[],
  cardType: GeneratedCardType = "basic",
): FixAction | null {
  if (codes.length === 0) return null;
  const actions = codes.map((c) => {
    const action = ACTION_BY_CODE[c];
    return action === "cloze" && cardType === "mcq" ? "split" : action;
  });
  if (actions.includes("split")) return "split";
  if (actions.includes("cloze")) return "cloze";
  if (actions.includes("add_context")) return "add_context";
  const distinct = new Set(actions);
  if (distinct.size === 1 && (distinct.has("even_out") || distinct.has("replace_distractor"))) {
    return actions[0];
  }
  return "rewrite";
}

/** What a question that does not parse offers: one flat list, or a type-in. */
export const INVALID_QUESTION_FIXES: readonly FixAction[] = ["flatten", "type_in"];

/** A question reworked as a type-in is a heading and a short answer, so the
 *  question check does not apply to it. */
export function isQuestionShaped(origin: CardOrigin | undefined): boolean {
  return origin !== "type_in";
}

/** What to tell the model for a fix: the rubric's suggestion where the fix is generic,
 *  folded in for `add_context`, and never for a fix with a shape of its own. */
export function fixInstructionFor(action: FixAction, suggestion = ""): string {
  const g = I18n.t.modals.aiGenerator;
  const detail = suggestion.trim();
  switch (action) {
    case "split":
      return detail || g.fixSplitInstruction;
    case "cloze":
      return g.fixClozeInstruction;
    case "add_context":
      return I18n.format(g.fixContextInstruction, { detail }).trim();
    case "even_out":
      return detail ? `${g.fixEvenOutInstruction} ${detail}` : g.fixEvenOutInstruction;
    case "replace_distractor":
      return detail ? `${g.fixReplaceInstruction} ${detail}` : g.fixReplaceInstruction;
    case "flatten":
      return g.fixFlattenInstruction;
    case "type_in":
      return g.fixTypeInInstruction;
    default:
      return detail || g.fixRewriteInstruction;
  }
}

/** The fields a staged card is reworked as. A cloze fix sends it as a cloze, so
 *  the reply is a heading and a sentence carrying the ==blanks==. */
export function fixFields(
  card: Pick<GeneratedCard, "front" | "back">,
  action: FixAction | null,
): RefactorFieldSet {
  return action === "cloze"
    ? { type: "cloze", front: card.front, sentence: card.back }
    : { type: "header-paragraph", front: card.front, back: card.back };
}

/** A reworked field set as a staged card's front and back; null for a shape a
 *  staged card cannot hold. */
export function fixedCard(
  fields: RefactorFieldSet,
): Pick<GeneratedCard, "front" | "back"> | null {
  if (fields.type === "header-paragraph") return { front: fields.front, back: fields.back };
  if (fields.type === "cloze") return { front: fields.front, back: fields.sentence };
  return null;
}

/** How a card came to exist. With `parent_id`, this is what makes
 *  regeneration non-destructive. */
export type CardOrigin =
  | "generate"
  | "chat_capture"
  | "split"
  | "cloze"
  | "rewrite"
  | "add_context"
  | "even_out"
  | "replace_distractor"
  | "flatten"
  | "type_in";

/** The origin a fix produces. */
export function originForFix(action: FixAction): CardOrigin {
  return action;
}
