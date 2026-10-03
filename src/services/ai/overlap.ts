import type { GeneratedCard } from "./generation-prompt";

/** A card as the overlap check sees it. */
export interface OverlapCard {
  id: string;
  front: string;
  back: string;
}

export interface OverlapCandidate {
  stagedId: string;
  existingId: string;
  score: number;
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** Word tokens, plus character bigrams for scripts written without spaces. */
export function overlapTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.normalize("NFKC").toLowerCase();
  for (const word of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (CJK.test(word)) {
      for (let i = 0; i + 1 < word.length; i++) out.add(word.slice(i, i + 2));
      if (word.length === 1) out.add(word);
    } else if (word.length >= 3 || /^\d+$/.test(word)) {
      out.add(word);
    }
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * For each staged card, the existing cards whose words overlap most: the pairs
 * worth checking for the same fact. Cheap and local; the check decides.
 */
export function lexicalCandidates(
  staged: readonly OverlapCard[],
  existing: readonly OverlapCard[],
  k = 3,
  minScore = 0.2,
): OverlapCandidate[] {
  const existingTokens = existing.map((c) => ({ id: c.id, tokens: overlapTokens(`${c.front} ${c.back}`) }));
  const out: OverlapCandidate[] = [];
  for (const card of staged) {
    const tokens = overlapTokens(`${card.front} ${card.back}`);
    const scored = existingTokens
      .filter((e) => e.id !== card.id)
      .map((e) => ({ stagedId: card.id, existingId: e.id, score: jaccard(tokens, e.tokens) }))
      .filter((c) => c.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    out.push(...scored);
  }
  return out;
}

/** A generated card with the id it is compared under. */
export function overlapCardFor(id: string, card: GeneratedCard): OverlapCard {
  return { id, front: card.front, back: card.back };
}
