// Client-side prompts for generation and refactor.

/** Delimiter the model emits after each card block. */
export const CARD_DELIMITER = "===END===";

/**
 * Emitted once the model judges the source exhausted.
 *
 * A binary judgement is far more reliable than a self-estimated percentage, and
 * it answers the only question the user has: is there any point pressing
 * Continue? Treated as a hint — it stops the loop early, it does not disable
 * anything.
 */
export const COVERED_MARKER = "===COVERED===";

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
  `- When the source holds nothing substantive left to turn into a card, end your reply with a line containing only ${COVERED_MARKER}. Emit it only when the material is genuinely exhausted, not merely because the batch is full.`,
  '- Start each field on its own line with the label "FRONT:", "BACK:", or "NOTES:".',
  "- A field value may span multiple lines and may contain Markdown and $LaTeX$.",
  '- "NOTES:" is optional; include it empty or omit it when there is nothing to add.',
  '- When the source is split into numbered sections like "# [2] Title", add a "SECTION: 2" line naming the section the card came from. Use the number only, and omit the line if the source has no such headings.',
  '- When the source labels pages like "[p. 70]", add a "PAGE: 70" line naming the page the card was drawn from. Use the number only, copy it from the nearest label above the material you used, and omit the line if the source has no page labels. Never guess a page.',
  "- Output only the card blocks — no JSON, numbering, prose, or code fences.",
  "- Write the FRONT in normal sentence case.",
].join("\n");

/** Discourages repeats across continuation batches. */
export const DEDUP_RULE =
  "Never produce a card for a concept that already appears earlier in this conversation.";

/** Closes each generation request; the instruction is prepended to it. */
export const CONTINUE_TRIGGER =
  "Continue generating the next batch of atomic cards based on the source notes. Do not repeat any concept already listed.";

/** Follows a refining instruction: the cards above are replaced, not extended. */
export const REFINE_TRIGGER =
  "Rewrite the cards above to follow this instruction. Output the complete replacement set in the same format, including cards the instruction leaves unchanged, and nothing else.";

/** Appended for multiple-choice runs. The authored form is the one Decks
 *  already parses — a heading with a task list under it. */
export const MCQ_FORMAT = [
  "Write multiple-choice questions, not ordinary flashcards.",
  'Put the question stem in "FRONT:".',
  'Put the options in "BACK:", one per line, as a markdown task list: "- [ ] wrong option" and "- [x] the correct one".',
  "Mark exactly one option correct unless the question genuinely has several, in which case mark each of them.",
  "Give four options where the material allows it, and never fewer than two.",
  'Put the reason the answer is right in "NOTES:".',
  "",
  "Rules for the options:",
  "- Every option must be a plausible answer to the stem. An option nobody would pick teaches nothing.",
  "- Keep the options close in length. A conspicuously longer option gives the answer away.",
  '- Do not write "all of the above", "none of the above", or an option that refers to the other options.',
  "- Do not negate the stem (\"which is NOT…\"); ask it positively instead.",
  "- Use only top-level list items. No nested lists, no plain bullets mixed in with the task items.",
  "- Never leave an option empty.",
].join("\n");

/** Minimal concept-extraction prompt for bring-your-own-key providers. */
export const CONCEPT_RUBRIC = [
  "List the examinable concepts in the source: the things a student could be asked about and be right or wrong.",
  "",
  "- A concept is a term, a definition, a rule, a formula, or a named result.",
  "- Skip worked examples, exercises, solutions, contents pages and anything purely navigational. A page of solutions has nothing to learn on it, and saying so is the point.",
  "- Use the source's own wording for the term.",
  "- One line of explanation, enough to tell two similar concepts apart.",
  "- Do not invent concepts the source does not cover.",
].join("\n");

/** Output contract for the extraction pass. */
export const CONCEPT_FORMAT = [
  "For every concept, output one block in EXACTLY this format:",
  "TERM: <the concept, in the source's wording>",
  "PAGE: <the number only of the page it appears on, from the nearest [p. N] label above it>",
  "BLURB: <one line telling it apart from a similar concept>",
  CARD_DELIMITER,
  "",
  "Rules for the output:",
  `- End every block with a line containing only ${CARD_DELIMITER}.`,
  "- Output nothing at all for a page with nothing examinable on it.",
  "- Output only the blocks — no JSON, numbering, prose, or code fences.",
].join("\n");

/** Minimal chat rubric for bring-your-own-key providers; the backend builds its
 *  own. Grounding in the attached source is the whole contract. */
export const CHAT_RUBRIC = [
  "Answer questions about the attached source only. You are talking to someone making flashcards from it.",
  "",
  "- Answer from the source. If it does not say, say that it does not say.",
  "- Cite the page every claim comes from, copied from the nearest [p. N] label.",
  "- Be brief. A few sentences, not an essay.",
  "- When asked what is missing, compare the source against the cards listed as already made and the cards already in the destination deck, and name what has no card in either.",
  "- Never invent a page number or a gap.",
].join("\n");

/** Output contract for a chat answer. */
export const CHAT_FORMAT = [
  "Reply in EXACTLY this format:",
  "ANSWER: <your answer, which may span several lines>",
  "PAGES: <comma-separated page numbers the answer draws on, or empty>",
  "GAP: <one line per uncovered thing, as: term · p. N>",
  "",
  "Rules for the output:",
  "- Output GAP lines only when naming what has no card yet; omit them otherwise.",
  "- Output only these labels — no JSON, headings, prose outside ANSWER, or code fences.",
].join("\n");

/** Minimal critique rubric for bring-your-own-key providers; the backend builds
 *  its own. The codes are the contract, not the wording. */
export const CRITIQUE_RUBRIC = [
  "You are reviewing spaced-repetition flashcards someone else generated. Judge each card only against the rules below. Do not rewrite the cards.",
  "",
  "- enumeration: the card asks for a list or set ('name the three…'), which cannot be rated honestly as one card. A cloze that blanks each item separately (==solid==, ==liquid==, ==gas==) is the fix, not a breach.",
  "- two_facts: the card carries more than one fact, so a correct half and a wrong half share one rating.",
  "- answer_leak: the front gives the answer away, or contains an obvious cognate of it.",
  "- unanswerable_alone: the card only makes sense with the source in front of you — a dangling pronoun, 'the author', 'the above', an unnamed subject.",
  "- trivial: the card tests nothing worth scheduling.",
  "",
  "A card breaking none of these passes. Judge what the card says, not how it is worded.",
].join("\n");

/** Added to the critique when the round is questions rather than cards. */
export const DISTRACTOR_RUBRIC = [
  "These cards are multiple-choice questions. Judge the options as well, using these codes:",
  "",
  "- length_cue: the correct option is conspicuously longer or shorter than the rest.",
  "- implausible_distractor: an option nobody would seriously pick.",
  "- two_defensible: only one option is marked correct, but another is arguable.",
  "- negation_stem: the stem asks which option is NOT true.",
  "- all_of_the_above: an option is \"all of the above\", \"none of the above\", or refers to the other options.",
  "- stem_leak: the stem's wording gives the answer away — a grammatical agreement, a repeated word.",
].join("\n");

/** Verdict output contract for the critique pass. */
export const CRITIQUE_FORMAT = [
  "For EVERY card, output one block in EXACTLY this format:",
  "ID: <the card's id, copied exactly>",
  "VERDICT: pass | flagged",
  "CODES: <comma-separated codes, or empty when the verdict is pass>",
  "FIX: <one short sentence naming the concrete change, or empty when the verdict is pass>",
  CARD_DELIMITER,
  "",
  "Rules for the output:",
  `- End every block with a line containing only ${CARD_DELIMITER}.`,
  "- Emit exactly one block per card given, in the same order, including the ones that pass.",
  "- Use only the codes listed above; invent no new ones.",
  "- Output only the blocks — no JSON, numbering, prose, or code fences.",
].join("\n");

/** Appended to the refactor system prompt when splitting a card. */
export const SPLIT_INSTRUCTION = [
  "Split this flashcard into multiple smaller, single-idea cards (apply the minimum information principle).",
  "Each resulting card must keep the same field structure as the original card.",
  "Produce as many cards as the content naturally warrants (usually 2–5); do not pad with redundant cards.",
].join("\n");
