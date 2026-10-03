import {
  CARD_DELIMITER,
  CRITIQUE_FORMAT,
  CRITIQUE_RUBRIC,
  DISTRACTOR_RUBRIC,
} from "./prompts";
import type { GeneratedCard } from "./generation-prompt";

/** Scoring generated cards against a card-authoring rubric. A separate call,
 *  and it never rejects. */

/** Card-quality violations. A contract: codes may be added, never renamed or
 *  repurposed. */
export const RUBRIC_CODES = [
  "enumeration",
  "two_facts",
  "answer_leak",
  "unanswerable_alone",
  "trivial",
  // Distractor quality. A question can be a perfectly good card and still be a
  // bad question, which is a failure mode nothing else checks.
  "length_cue",
  "implausible_distractor",
  "two_defensible",
  "negation_stem",
  "all_of_the_above",
  "stem_leak",
] as const;

/** The codes that only apply to a question, not an ordinary card. */
export const DISTRACTOR_CODES = [
  "length_cue",
  "implausible_distractor",
  "two_defensible",
  "negation_stem",
  "all_of_the_above",
  "stem_leak",
] as const;

export function isDistractorCode(code: RubricCode): boolean {
  return (DISTRACTOR_CODES as readonly string[]).includes(code);
}

export type RubricCode = (typeof RUBRIC_CODES)[number];

export function isRubricCode(value: string): value is RubricCode {
  return (RUBRIC_CODES as readonly string[]).includes(value);
}

export type RubricVerdict = "pass" | "flagged";

export interface CardVerdict {
  /** The id the request used for this card. */
  id: string;
  verdict: RubricVerdict;
  codes: RubricCode[];
  /** The critique's suggested change, unapplied. */
  fix: string;
}

/** A flagged card someone chose to keep: passed by hand, its codes left as the reason it was flagged. */
export function isKeptOverFlag(v: Pick<CardVerdict, "verdict" | "codes">): boolean {
  return v.verdict === "pass" && v.codes.length > 0;
}

/** One card as the critique sees it — an id plus the text to judge. */
export interface CritiqueCard {
  id: string;
  card: GeneratedCard;
}

export interface CritiqueRequest {
  cards: CritiqueCard[];
  /** Judge distractor quality as well as card quality. */
  cardType?: "basic" | "mcq";
  /** When true, the built messages and raw response are attached for debugging. */
  debug?: boolean;
}

/** Render the cards into the payload the critique reads. */
export function serializeForCritique(cards: readonly CritiqueCard[]): string {
  return cards
    .map(({ id, card }) => {
      const lines = [`ID: ${id}`, `FRONT: ${card.front}`, `BACK: ${card.back}`];
      if (card.notes.trim()) lines.push(`NOTES: ${card.notes}`);
      lines.push(CARD_DELIMITER);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Messages for a bring-your-own-key critique. The backend builds its own. */
export function buildCritiqueMessages(req: CritiqueRequest): {
  system: string;
  user: string;
} {
  return {
    system:
      req.cardType === "mcq"
        ? `${CRITIQUE_RUBRIC}\n\n${DISTRACTOR_RUBRIC}\n\n${CRITIQUE_FORMAT}`
        : `${CRITIQUE_RUBRIC}\n\n${CRITIQUE_FORMAT}`,
    user: `Review these ${req.cards.length} cards:\n\n${serializeForCritique(req.cards)}`,
  };
}

const LABEL_RE = /^\s*(ID|VERDICT|CODES|FIX)\s*:(.*)$/i;

const CLOZE_SPAN = /==((?:(?!==).)+)==/g;

/** A card whose answer already blanks two or more items is the list rule's fix,
 *  not a breach of it, so `enumeration` is dropped there whatever the model said. */
export function settleVerdicts(
  verdicts: readonly CardVerdict[],
  cards: readonly CritiqueCard[],
  cardType: "basic" | "mcq" = "mcq",
): CardVerdict[] {
  const blanked = new Set(
    cards
      .filter((c) => (c.card.back.match(CLOZE_SPAN) ?? []).length >= 2)
      .map((c) => c.id),
  );
  return verdicts.map((v) => {
    // A card with no options cannot have an options fault.
    const dropped = (c: RubricCode): boolean =>
      (c === "enumeration" && blanked.has(v.id)) ||
      (cardType === "basic" && isDistractorCode(c));
    if (!v.codes.some(dropped)) return v;
    const codes = v.codes.filter((c) => !dropped(c));
    return codes.length > 0
      ? { ...v, codes }
      : { ...v, verdict: "pass", codes, fix: "" };
  });
}

/** Parse the verdict blocks. Forgiving by design: a half-parsed critique
 *  leaves cards unjudged rather than breaking the round. */
export function parseVerdicts(text: string): CardVerdict[] {
  const out: CardVerdict[] = [];
  for (const segment of text.split(CARD_DELIMITER)) {
    const buf: Record<"id" | "verdict" | "codes" | "fix", string[]> = {
      id: [],
      verdict: [],
      codes: [],
      fix: [],
    };
    let current: "id" | "verdict" | "codes" | "fix" | null = null;
    for (const line of segment.split("\n")) {
      const m = LABEL_RE.exec(line);
      if (m) {
        current = m[1].toLowerCase() as "id" | "verdict" | "codes" | "fix";
        buf[current].push(m[2]);
      } else if (current) {
        buf[current].push(line);
      }
    }
    const id = buf.id.join("\n").trim();
    if (!id) continue;

    const codes = buf.codes
      .join(",")
      .split(",")
      .map((c) => c.trim().toLowerCase().replace(/[\s-]+/g, "_"))
      .filter(isRubricCode);

    // Codes win over the verdict line: a model listing them has found a fault.
    const said = buf.verdict.join(" ").trim().toLowerCase();
    const verdict: RubricVerdict =
      codes.length > 0 || said.includes("flag") ? "flagged" : "pass";

    out.push({
      id,
      verdict,
      codes: [...new Set(codes)],
      fix: verdict === "flagged" ? buf.fix.join("\n").trim() : "",
    });
  }
  return out;
}
