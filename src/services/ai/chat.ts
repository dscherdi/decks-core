import { CHAT_FORMAT, CHAT_RUBRIC } from "./prompts";

/** Something the source covers that nothing has a card for yet. */
export interface AnswerGap {
  term: string;
  page: number | null;
}

export interface ChatAnswer {
  text: string;
  /** Pages the answer draws on, for the chips under it. */
  pages: number[];
  gaps: AnswerGap[];
}

/** One earlier exchange, so a follow-up question means something. */
export interface ChatTurn {
  question: string;
  answer: string;
}

export interface ChatRequest {
  question: string;
  /** Page-labelled source text, as `buildSectionContent` produces it. */
  source: string;
  /** Fronts of the cards already made, so "what did I miss" has something to
   *  compare against. */
  staged?: readonly string[];
  /** Concepts the ledger knows have no card — ground truth, not a guess. */
  uncovered?: readonly string[];
  /** Fronts of the cards already in the destination deck, capped by `deckForChat`. */
  deck?: readonly string[];
  history?: readonly ChatTurn[];
  debug?: boolean;
}

/** A deck's fronts are a comparison list, not reading matter; past this many they only cost context. */
export const CHAT_DECK_CARDS = 150;

export function deckForChat(fronts: readonly string[]): string[] {
  return fronts.slice(0, CHAT_DECK_CARDS);
}

/** Older turns cost context without earning it; a follow-up reaches back a few. */
export const CHAT_HISTORY_TURNS = 6;

export function recentTurns(
  history: readonly ChatTurn[],
  limit = CHAT_HISTORY_TURNS,
): ChatTurn[] {
  return history.slice(-limit);
}

/** Messages for a bring-your-own-key answer; the backend builds its own. */
export function buildChatMessages(req: ChatRequest): {
  system: string;
  user: string;
} {
  const parts: string[] = [`Here is the source:\n\n${req.source}`];
  if (req.staged?.length) {
    parts.push(
      `Cards already made from it:\n${req.staged.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  if (req.deck?.length) {
    parts.push(
      `Cards already in the destination deck:\n${deckForChat(req.deck).map((f) => `- ${f}`).join("\n")}`,
    );
  }
  if (req.uncovered?.length) {
    parts.push(
      `Concepts in the source with no card yet:\n${req.uncovered
        .map((t) => `- ${t}`)
        .join("\n")}`,
    );
  }
  for (const turn of recentTurns(req.history ?? [])) {
    parts.push(`Earlier question: ${turn.question}\nYour answer: ${turn.answer}`);
  }
  parts.push(`Question: ${req.question}`);
  return {
    system: `${CHAT_RUBRIC}\n\n${CHAT_FORMAT}`,
    user: parts.join("\n\n---\n\n"),
  };
}

const LABEL_RE = /^\s*(ANSWER|PAGES|GAP)\s*:(.*)$/i;
const GAP_PAGE_RE = /p\.?\s*(\d{1,5})\s*$/i;

/**
 * Parse an answer. Forgiving in the same way the other parsers are: a reply
 * with no labels at all is taken as the answer rather than thrown away.
 */
export function parseChatAnswer(raw: string): ChatAnswer {
  const answer: string[] = [];
  const pages: number[] = [];
  const gaps: AnswerGap[] = [];
  let current: "answer" | "pages" | null = null;
  let sawLabel = false;
  for (const line of raw.split("\n")) {
    const m = LABEL_RE.exec(line);
    if (m) {
      sawLabel = true;
      const label = m[1].toUpperCase();
      if (label === "GAP") {
        current = null;
        const body = m[2].trim();
        if (!body) continue;
        const hit = GAP_PAGE_RE.exec(body);
        gaps.push({
          term: body
            .replace(GAP_PAGE_RE, "")
            .replace(/[·|(,\-–—\s]+$/, "")
            .trim(),
          page: hit ? Number.parseInt(hit[1], 10) : null,
        });
        continue;
      }
      current = label === "ANSWER" ? "answer" : "pages";
      if (current === "answer") answer.push(m[2]);
      else pages.push(...readPages(m[2]));
      continue;
    }
    if (current === "answer") answer.push(line);
    else if (current === "pages") pages.push(...readPages(line));
  }
  return {
    text: (sawLabel ? answer.join("\n") : raw).trim(),
    pages: [...new Set(pages)].sort((a, b) => a - b),
    gaps: gaps.filter((g) => g.term !== ""),
  };
}

function readPages(text: string): number[] {
  return (text.match(/\d{1,5}/g) ?? []).map((n) => Number.parseInt(n, 10));
}
