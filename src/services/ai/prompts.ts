// Client-side prompts for generation and refactor.

/** Delimiter the model emits after each card block. */
export const CARD_DELIMITER = "===END===";

/** Short explanation of how Decks cards work. */
export const DECKS_OVERVIEW = [
  "You create spaced-repetition flashcards for Decks, an Obsidian plugin.",
  "Card formats: header + paragraph (heading is the front, the text below is the back), table (front | back | optional notes), cloze (wrap hidden text in ==double equals==), image occlusion (an image plus a numbered list), and spatial (two connected Canvas nodes).",
  "All card text is Markdown; write math as $LaTeX$. Keep each card to a single fact.",
].join("\n");

/** Generation output contract — the streaming parser depends on this format. */
export const GENERATION_FORMAT = [
  "Output flashcards as plain text in EXACTLY this format, one block per card:",
  "FRONT: <the prompt/question>",
  "BACK: <the answer>",
  "NOTES: <optional extra detail, or leave empty>",
  CARD_DELIMITER,
  "",
  "Rules for the output:",
  `- End every card with a line containing only ${CARD_DELIMITER}.`,
  '- Start each field on its own line with the label "FRONT:", "BACK:", or "NOTES:".',
  "- A field value may span multiple lines and may contain Markdown and $LaTeX$.",
  '- "NOTES:" is optional; include it empty or omit it when there is nothing to add.',
  "- Output only the card blocks — no JSON, numbering, prose, or code fences.",
  "- Write the FRONT in normal sentence case.",
].join("\n");

/** Discourages repeats across continuation batches. */
export const DEDUP_RULE =
  "Never produce a card for a concept that already appears earlier in this conversation.";

/** Closes each generation request; the instruction is prepended to it. */
export const CONTINUE_TRIGGER =
  "Continue generating the next batch of atomic cards based on the source notes. Do not repeat any concept already listed.";

/** Appended to the refactor system prompt when splitting a card. */
export const SPLIT_INSTRUCTION = [
  "Split this flashcard into multiple smaller, single-idea cards (apply the minimum information principle).",
  "Each resulting card must keep the same field structure as the original card.",
  "Produce as many cards as the content naturally warrants (usually 2–5); do not pad with redundant cards.",
].join("\n");
